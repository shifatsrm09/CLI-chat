/**
 * CLI Chat - Native Console Host with System Tray Integration
 *
 * Runs dev.js directly in a true native Windows Console:
 *  - 100% authentic CMD line-by-line terminal input & execution
 *  - Full TTY support (smooth animated progress bars, clearLine, ANSI colors)
 *  - All commands (/target, /ls, /help, /send, /w, /room) work natively with zero glitches
 *  - No prompt duplication (rootgui: CFAT: hi will never happen)
 *  - Clicking 'X' (close) or Alt+F4 intercepts the event and hides to System Tray
 *  - Double-click tray icon to restore the terminal window
 *  - Right-click tray menu: "Open Terminal", "Hide to Tray", "Exit cli-chat"
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>

#pragma comment(lib, "shell32.lib")

#define ID_TRAY_ICON     2001
#define ID_TRAY_RESTORE  2002
#define ID_TRAY_HIDE     2003
#define ID_TRAY_EXIT     2004

#define WM_APP_TRAY      (WM_APP + 1)

/* ─── Global State ───────────────────────────────────────────────────────── */
static HINSTANCE        g_hInstance     = NULL;
static HWND             g_hWndHost      = NULL; // Message-only window for Tray
static HWND             g_hConsole      = NULL; // Real Console Window
static HHOOK            g_hMouseHook    = NULL;
static HHOOK            g_hKbdHook      = NULL;
static NOTIFYICONDATAW  g_nid           = {0};
static bool             g_bTrayActive   = false;
static bool             g_bExiting      = false;

static HANDLE           g_hChildProcess = NULL;
static std::thread*     g_pWaitThread   = nullptr;

/* ─── Forward Declarations ───────────────────────────────────────────────── */
LRESULT CALLBACK TrayHostWndProc(HWND, UINT, WPARAM, LPARAM);
LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam);
LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam);
void ShowConsole(bool show);
void ShowTrayBalloon(const std::wstring& title, const std::wstring& msg);
void Cleanup();

/* ─── Entry Point ────────────────────────────────────────────────────────── */
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE, LPSTR, int nCmdShow) {
    g_hInstance = hInstance;

    // 1. Allocate dedicated native Windows Console
    AllocConsole();
    g_hConsole = GetConsoleWindow();

    if (g_hConsole) {
        SetConsoleTitleW(L"cli-chat (dev)");

        // Enable native ANSI escape codes and line editing in Windows Console
        HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
        if (hOut != INVALID_HANDLE_VALUE) {
            DWORD dwMode = 0;
            if (GetConsoleMode(hOut, &dwMode)) {
                dwMode |= ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT;
                SetConsoleMode(hOut, dwMode);
            }
        }

        HANDLE hIn = GetStdHandle(STD_INPUT_HANDLE);
        if (hIn != INVALID_HANDLE_VALUE) {
            DWORD dwMode = 0;
            if (GetConsoleMode(hIn, &dwMode)) {
                dwMode |= ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT;
                SetConsoleMode(hIn, dwMode);
            }
        }
    }

    // 2. Create hidden message-only window for Tray notifications & menu
    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc   = TrayHostWndProc;
    wc.hInstance     = hInstance;
    wc.lpszClassName = L"CLIChatTrayHostClass";

    RegisterClassExW(&wc);

    g_hWndHost = CreateWindowExW(
        0,
        L"CLIChatTrayHostClass",
        L"CLIChatHost",
        0, 0, 0, 0, 0,
        HWND_MESSAGE, NULL, hInstance, NULL
    );

    // 3. Setup System Tray Icon
    memset(&g_nid, 0, sizeof(g_nid));
    g_nid.cbSize           = sizeof(g_nid);
    g_nid.hWnd             = g_hWndHost;
    g_nid.uID              = ID_TRAY_ICON;
    g_nid.uFlags           = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_APP_TRAY;
    g_nid.hIcon            = LoadIcon(NULL, IDI_APPLICATION);
    wcscpy_s(g_nid.szTip, L"cli-chat (dev)");
    Shell_NotifyIconW(NIM_ADD, &g_nid);
    g_bTrayActive = true;

    // 4. Install Low-Level Mouse & Keyboard Hooks to intercept 'X' and Alt+F4
    g_hMouseHook = SetWindowsHookExW(WH_MOUSE_LL, LowLevelMouseProc, GetModuleHandle(NULL), 0);
    g_hKbdHook   = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, GetModuleHandle(NULL), 0);

    // 5. Build command line forwarding all CLI arguments to dev.js
    std::wstring cmdArgs;
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv && argc > 1) {
        for (int i = 1; i < argc; ++i) {
            if (!cmdArgs.empty()) cmdArgs += L" ";
            cmdArgs += argv[i];
        }
        LocalFree(argv);
    }

    std::wstring cmdLine = L"node.exe dev.js";
    if (!cmdArgs.empty()) {
        cmdLine += L" " + cmdArgs;
    }

    // 6. Spawn node.exe dev.js attached directly to this console
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {0};

    std::vector<wchar_t> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back(L'\0');

    // Inherit console handles directly so process.stdout.isTTY == true!
    BOOL success = CreateProcessW(
        NULL,
        cmdBuf.data(),
        NULL,
        NULL,
        TRUE,
        0, // Standard creation attached to the current console
        NULL,
        NULL,
        &si,
        &pi
    );

    if (success) {
        g_hChildProcess = pi.hProcess;
        CloseHandle(pi.hThread);

        // Background thread waits for dev.js to exit (e.g. user typed /quit)
        g_pWaitThread = new std::thread([]() {
            if (g_hChildProcess) {
                WaitForSingleObject(g_hChildProcess, INFINITE);
            }
            if (!g_bExiting && g_hWndHost) {
                PostMessageW(g_hWndHost, WM_CLOSE, 0, 0);
            }
        });
    }

    // 7. Message Loop for Tray Icon events and hooks
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    Cleanup();
    return 0;
}

/* ─── Show / Hide Console ────────────────────────────────────────────────── */
void ShowConsole(bool show) {
    if (!g_hConsole || !IsWindow(g_hConsole)) return;

    if (show) {
        ShowWindow(g_hConsole, SW_RESTORE);
        SetForegroundWindow(g_hConsole);
    } else {
        ShowWindow(g_hConsole, SW_HIDE);
        ShowTrayBalloon(L"cli-chat (dev)", L"cli-chat is running in the background. Double-click tray icon to reopen.");
    }
}

/* ─── Low-Level Mouse Hook (Intercepts clicking 'X' on Console) ──────────── */
LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && wParam == WM_LBUTTONDOWN) {
        MSLLHOOKSTRUCT* pMouse = (MSLLHOOKSTRUCT*)lParam;
        if (g_hConsole && IsWindow(g_hConsole) && IsWindowVisible(g_hConsole)) {
            RECT rc;
            GetWindowRect(g_hConsole, &rc);
            if (PtInRect(&rc, pMouse->pt)) {
                LRESULT hit = SendMessageW(g_hConsole, WM_NCHITTEST, 0, MAKELPARAM(pMouse->pt.x, pMouse->pt.y));
                if (hit == HTCLOSE) {
                    // Intercept 'X' click -> Hide to System Tray!
                    ShowConsole(false);
                    return 1; // Drop the mouse click so ConHost does not close!
                }
            }
        }
    }
    return CallNextHookEx(g_hMouseHook, nCode, wParam, lParam);
}

/* ─── Low-Level Keyboard Hook (Intercepts Alt+F4 on Console) ─────────────── */
LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
        KBDLLHOOKSTRUCT* pKbd = (KBDLLHOOKSTRUCT*)lParam;
        if (pKbd->vkCode == VK_F4 && (pKbd->flags & LLKHF_ALTDOWN)) {
            if (GetForegroundWindow() == g_hConsole) {
                // Intercept Alt+F4 -> Hide to System Tray!
                ShowConsole(false);
                return 1; // Drop Alt+F4
            }
        }
    }
    return CallNextHookEx(g_hKbdHook, nCode, wParam, lParam);
}

/* ─── Tray Host Window Procedure ─────────────────────────────────────────── */
LRESULT CALLBACK TrayHostWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_APP_TRAY: {
            if (lParam == WM_LBUTTONDBLCLK) {
                ShowConsole(true);
            }
            else if (lParam == WM_RBUTTONUP) {
                POINT pt;
                GetCursorPos(&pt);
                HMENU hMenu = CreatePopupMenu();
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_RESTORE, L"Show Terminal");
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_HIDE,    L"Hide to Tray");
                AppendMenuW(hMenu, MF_SEPARATOR, 0, NULL);
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_EXIT,    L"Exit cli-chat");

                SetForegroundWindow(hWnd);
                int cmd = TrackPopupMenu(hMenu, TPM_RETURNCMD | TPM_NONOTIFY, pt.x, pt.y, 0, hWnd, NULL);
                DestroyMenu(hMenu);

                if (cmd == ID_TRAY_RESTORE) {
                    ShowConsole(true);
                } else if (cmd == ID_TRAY_HIDE) {
                    ShowConsole(false);
                } else if (cmd == ID_TRAY_EXIT) {
                    g_bExiting = true;
                    PostQuitMessage(0);
                }
            }
            return 0;
        }

        case WM_CLOSE: {
            g_bExiting = true;
            PostQuitMessage(0);
            return 0;
        }
    }
    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

/* ─── Tray Notification Balloon ──────────────────────────────────────────── */
void ShowTrayBalloon(const std::wstring& title, const std::wstring& msg) {
    if (!g_bTrayActive) return;

    g_nid.uFlags |= NIF_INFO;
    wcsncpy_s(g_nid.szInfoTitle, title.c_str(), _TRUNCATE);
    wcsncpy_s(g_nid.szInfo, msg.c_str(), _TRUNCATE);
    g_nid.dwInfoFlags = NIIF_INFO;
    g_nid.uTimeout = 3000;

    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

/* ─── Cleanup ────────────────────────────────────────────────────────────── */
void Cleanup() {
    g_bExiting = true;

    if (g_hMouseHook) {
        UnhookWindowsHookEx(g_hMouseHook);
        g_hMouseHook = NULL;
    }

    if (g_hKbdHook) {
        UnhookWindowsHookEx(g_hKbdHook);
        g_hKbdHook = NULL;
    }

    if (g_bTrayActive) {
        Shell_NotifyIconW(NIM_DELETE, &g_nid);
        g_bTrayActive = false;
    }

    if (g_hChildProcess) {
        if (WaitForSingleObject(g_hChildProcess, 500) == WAIT_TIMEOUT) {
            TerminateProcess(g_hChildProcess, 0);
        }
        CloseHandle(g_hChildProcess);
        g_hChildProcess = NULL;
    }

    if (g_pWaitThread) {
        if (g_pWaitThread->joinable()) {
            g_pWaitThread->join();
        }
        delete g_pWaitThread;
        g_pWaitThread = nullptr;
    }

    if (g_hConsole) {
        FreeConsole();
        g_hConsole = NULL;
    }
}
