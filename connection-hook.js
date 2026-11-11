import { yaml } from '../../../../lib.js';

/**
 * ConnectionManager hook for extensions that never fire
 * CHAT_COMPLETION_SETTINGS_READY.
 *
 * The main-chat path (openai.js Generate -> emit
 * CHAT_COMPLETION_SETTINGS_READY) lets index.js inject the x-opencode-* headers
 * into generate_data. Third-party extensions such as Summaryception instead call
 * `SillyTavern.getContext().ChatCompletionService.processRequest(...)` directly,
 * which posts straight to /api/backends/chat-completions/generate, so that event
 * never fires and the upstream answers `400 MissingSessionID`.
 *
 * We wrap processRequest and inject the same headers into the outgoing payload.
 * The server only merges `custom_include_headers` for the CUSTOM chat completion
 * source, so the target profile must use the custom API type; this hook never
 * rewrites the source, the URL, or the secret id.
 */

let installed = false;

/**
 * @typedef {object} HookDeps
 * @property {() => any} getContext
 * @property {(url: string) => boolean} isOpencodeEndpoint
 * @property {(text?: string) => Record<string, string>} parseHeadersYaml
 * @property {(headers: Record<string, string>) => void} addHeaders - Mutates the header map with the x-opencode-* values.
 */

/**
 * Install the processRequest wrapper once.
 * @param {HookDeps} deps
 * @returns {boolean} Whether the hook is installed.
 */
export function installConnectionManagerHook(deps) {
    if (installed) return true;

    const { getContext, isOpencodeEndpoint, parseHeadersYaml, addHeaders } = deps;
    const context = getContext();
    const service = context?.ChatCompletionService;

    if (!service || typeof service.processRequest !== 'function') {
        markHookState('pending');
        return false;
    }

    if (service.processRequest.__ocgoWrapped) {
        installed = true;
        markHookState('installed');
        return true;
    }

    const original = service.processRequest;

    const wrapped = function wrappedProcessRequest(requestData, ...rest) {
        try {
            if (requestData && typeof requestData === 'object') {
                const url =
                    requestData.custom_url ||
                    requestData.reverse_proxy ||
                    getContext()?.oai_settings?.custom_url ||
                    '';
                const headers = parseHeadersYaml(requestData.custom_include_headers);
                // The main-chat path already injected them via
                // CHAT_COMPLETION_SETTINGS_READY; do not rotate the request id twice.
                if (isOpencodeEndpoint(url) && !headers['x-opencode-session']) {
                    addHeaders(headers);
                    requestData.custom_include_headers = yaml.stringify(headers);
                }
            }
        } catch (error) {
            // Never break a request because of header injection.
            console.warn('[OpenCodeGoHeader] ConnectionManager hook skipped:', error);
        }
        return original.call(this, requestData, ...rest);
    };

    wrapped.__ocgoWrapped = true;
    service.processRequest = wrapped;
    installed = true;
    markHookState('installed');
    console.log('[OpenCodeGoHeader] ConnectionManager hook installed.');
    return true;
}

/**
 * Exposes the hook state on the root element so support can check it from the
 * DOM without devtools access.
 * @param {'pending' | 'installed'} state
 */
function markHookState(state) {
    try {
        document.documentElement.dataset.ocgoHook = state;
    } catch {
        // ignore: diagnostics only
    }
}

/**
 * @returns {boolean} Whether the hook is installed.
 */
export function isConnectionManagerHookInstalled() {
    return installed;
}
