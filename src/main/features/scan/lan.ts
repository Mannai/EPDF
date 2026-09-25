import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

/** Finding the addresses a phone on the same network could reach. */

export interface LanAddress {
  address: string
  interfaceName: string
  /** Looks like a virtual adapter (WSL, Hyper-V, Docker, VPN): usually not reachable from a phone. */
  likelyVirtual: boolean
}

/** RFC 1918 private IPv4 space. Link-local (169.254/16) and carrier-grade NAT (100.64/10, e.g. Tailscale) are excluded on purpose. */
export function isPrivateIPv4(a: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (!m) return false
  const [o1, o2] = [Number(m[1]), Number(m[2])]
  if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) return false
  return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168)
}

const VIRTUAL = /vethernet|hyper-v|wsl|docker|virtualbox|vbox|vmware|vmnet|loopback|pseudo|tailscale|zerotier|bluetooth|vpn|\btap\b|tap-|\btun\d|utun|bridge|podman|lxc|veth|virbr/i

export function listLanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = []
  for (const [name, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      const v4 = info.family === 'IPv4' || (info.family as unknown) === 4
      if (!v4 || info.internal || !isPrivateIPv4(info.address)) continue
      out.push({ address: info.address, interfaceName: name, likelyVirtual: VIRTUAL.test(name) })
    }
  }
  const rank = (a: LanAddress): number => (a.likelyVirtual ? 10 : 0) + (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address))
}
