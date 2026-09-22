const koffi = require('koffi')

const user32 = koffi.load('user32.dll')

const RECT = koffi.struct('RECT', {
    left: 'int32_t',
    top: 'int32_t',
    right: 'int32_t',
    bottom: 'int32_t',
})

const SetProcessDPIAware = user32.func('bool __stdcall SetProcessDPIAware()')
SetProcessDPIAware()

const FindWindowW = user32.func(
    'void * __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'
)
const GetWindowRect = user32.func(
    'bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)'
)
const SetForegroundWindow = user32.func(
    'bool __stdcall SetForegroundWindow(void *hWnd)'
)

class Window {
    constructor(hwnd) {
        this.hwnd = hwnd
    }

    static getByTitle(title) {
        const hwnd = FindWindowW(null, title)
        if (!hwnd) return undefined
        return new Window(hwnd)
    }

    getDimensions() {
        const rect = {}
        if (!GetWindowRect(this.hwnd, rect)) return null
        return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }

    focus() {
        SetForegroundWindow(this.hwnd)
    }
}

module.exports = { Window }
