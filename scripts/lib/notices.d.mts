import type { Plugin } from 'vite'

export function thirdPartyNotices(): Plugin
export function renderNotices(packageDirs: Iterable<string>): string
export function writeNotices(extraPackageDirs?: Iterable<string>): { file: string; packages: number }
