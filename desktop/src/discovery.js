import { Bonjour } from 'bonjour-service';

// Discovery carries only a public identifier. The QR-pinned TLS certificate authenticates it.
export function advertiseComputer(identity, port, onError = () => {}) {
  let bonjour;
  let service;
  const stop = () => {
    service?.stop();
    bonjour?.destroy();
    service = bonjour = undefined;
  };
  const refresh = () => {
    stop();
    try {
      bonjour = new Bonjour(undefined, onError);
      service = bonjour.publish({
        name: `ct45-${identity.id}`, host: `ct45-${identity.id}.local`,
        type: 'ct45link', port, txt: { id: identity.id, v: '2' }, disableIPv6: true,
      });
      service.on('error', onError);
    } catch (e) { onError(e); }
  };
  refresh();
  return { refresh, stop };
}
