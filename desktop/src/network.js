import os from 'node:os';

const VIRTUAL = /^(utun|tun|tap|ipsec|ppp|vEthernet|docker|br-|bridge|vmnet|vboxnet|VirtualBox|VMware|zt|tailscale|wg|awdl|llw)/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// IPv4 addresses the CT45 might reach this computer on, most likely first: normal Wi-Fi or
// Ethernet LAN addresses, then anything else, then VPN and virtual-machine adapters.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // self-assigned: no working network
      const rank = VIRTUAL.test(name) ? 2 : PRIVATE.test(a.address) ? 0 : 1;
      found.push({ address: a.address, rank });
    }
  }
  return [...new Set(found.sort((x, y) => x.rank - y.rank).map((a) => a.address))];
}

// The name shown on the CT45 once it's connected.
export function computerName() {
  const host = os.hostname().replace(/\.local$/i, '').replace(/[-_]/g, ' ');
  return host || 'Computer';
}
