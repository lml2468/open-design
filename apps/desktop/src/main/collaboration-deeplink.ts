import { app } from 'electron';
import {
  COLLABORATION_DEEPLINK_SCHEME,
  createCollaborationDeeplinkDispatcher,
  findCollaborationDeeplinkArg,
  handleCollaborationDeeplink,
  planProtocolClientRegistration,
  type CollaborationDeeplinkDeps,
} from './collaboration-deeplink-core.js';

export {
  COLLABORATION_DEEPLINK_SCHEME,
  createCollaborationDeeplinkDispatcher,
  findCollaborationDeeplinkArg,
  handleCollaborationDeeplink,
  planProtocolClientRegistration,
  type CollaborationDeeplinkDeps,
} from './collaboration-deeplink-core.js';

const dispatcher = createCollaborationDeeplinkDispatcher();
let secondInstanceHandlerRegistered = false;

function attachOpenUrlListenerWhenHosted(): void {
  if (typeof app?.on !== 'function') return;
  app.on('open-url', (event, url) => {
    event.preventDefault();
    dispatcher.dispatch(url);
  });
}

attachOpenUrlListenerWhenHosted();

export function dispatchCollaborationDeeplink(url: string | null): void {
  dispatcher.dispatch(url);
}

export function registerCollaborationDeeplink(deps: CollaborationDeeplinkDeps): void {
  const registration = planProtocolClientRegistration({
    isPackaged: app?.isPackaged === true,
    platform: process.platform,
    protocolClientPath: deps.protocolClientPath,
  });
  if (registration.register) {
    if (registration.clientPath) {
      app.setAsDefaultProtocolClient(COLLABORATION_DEEPLINK_SCHEME, registration.clientPath);
    } else {
      app.setAsDefaultProtocolClient(COLLABORATION_DEEPLINK_SCHEME);
    }
  }
  dispatcher.setDeps(deps);

  if (!secondInstanceHandlerRegistered) {
    secondInstanceHandlerRegistered = true;
    app.on('second-instance', (_event, argv) => {
      dispatcher.dispatch(findCollaborationDeeplinkArg(argv));
    });
  }

  const initial = findCollaborationDeeplinkArg(process.argv);
  if (initial) void app.whenReady().then(() => dispatcher.dispatch(initial));
}
