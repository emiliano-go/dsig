/* Stand-in for @utils/Logger. */

export class Logger {
    constructor(public name: string, public colour?: string) { }
    log() { }
    info() { }
    warn() { }
    error() { }
    debug() { }
}
