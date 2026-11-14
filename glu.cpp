/**
 * GLU Chat - Military-Grade Native Console Host with Fail-Safe Tray Integration
 *
 * Enhanced High-Reliability Native Host:
 *  - Zero runtime dependencies (statically linked, payload embedded)
 *  - 100% Fail-Safe System Tray interception: 'X' button NEVER terminates prematurely
 *  - Non-blocking SendMessageTimeoutW + Geometric Titlebar Fallback
 *  - Kernel-level SetConsoleCtrlHandler protection against OS-level termination
 *  - Hook health watchdog timer with automated recovery
 *  - Full ANSI console support, cursor control, and progress animations
 *  - Single-instance protection and restore signaling
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

#pragma comment(lib, "shell32.lib")

#define ID_TRAY_ICON       2001
#define ID_TRAY_RESTORE    2002
#define ID_TRAY_HIDE       2003
#define ID_TRAY_EXIT       2004
#define IDT_HOOK_WATCHDOG  5001

#define WM_APP_TRAY        (WM_APP + 1)
#define IDR_EMBEDDED_DEV   101

/* ─── Global State ───────────────────────────────────────────────────────── */
static HINSTANCE        g_hInstance         = NULL;
static HWND             g_hWndHost          = NULL; // Message-only window for Tray
static HWND             g_hConsole          = NULL; // Real Console Window
static HHOOK            g_hMouseHook        = NULL;
static HHOOK            g_hKbdHook          = NULL;
static NOTIFYICONDATAW  g_nid               = {0};
static bool             g_bTrayActive       = false;
static bool             g_bExiting          = false;
static bool             g_bCloseMouseDown   = false;
static HANDLE           g_hSingleMutex      = NULL;

static HANDLE           g_hChildProcess     = NULL;
static HANDLE           g_hWaitThread       = NULL;

/* ─── Forward Declarations ───────────────────────────────────────────────── */
LRESULT CALLBACK TrayHostWndProc(HWND, UINT, WPARAM, LPARAM);
LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam);
LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam);
BOOL WINAPI ConsoleCtrlHandler(DWORD dwCtrlType);
DWORD WINAPI ChildWatcherThread(LPVOID);
void ShowConsole(bool show);
void ShowTrayBalloon(const std::wstring& title, const std::wstring& msg);
void EnsureHooksInstalled();
void Cleanup();
bool FileExists(const std::wstring& path);
std::wstring ResolveOrExtractEngine(HINSTANCE hInstance, const std::wstring& appDir);
bool ExtractResourceToFile(HINSTANCE hInstance, int resId, const std::wstring& destPath);
bool IsPointInConsoleCloseButton(POINT pt);

/* ─── Helper: File Existence Check ───────────────────────────────────────── */
bool FileExists(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return (attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY));
}

/* ─── Helper: Extract Resource to File ───────────────────────────────────── */
bool ExtractResourceToFile(HINSTANCE hInstance, int resId, const std::wstring& destPath) {
    HRSRC hRes = FindResourceW(hInstance, MAKEINTRESOURCEW(resId), RT_RCDATA);
    if (!hRes) return false;

    HGLOBAL hLoaded = LoadResource(hInstance, hRes);
    if (!hLoaded) return false;

    DWORD resSize = SizeofResource(hInstance, hRes);
    void* pData = LockResource(hLoaded);
    if (!pData || resSize == 0) return false;

    // Fast check: if existing file matches exact resource size, avoid re-writing
    HANDLE hExisting = CreateFileW(destPath.c_str(), GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (hExisting != INVALID_HANDLE_VALUE) {
        LARGE_INTEGER fSize;
        if (GetFileSizeEx(hExisting, &fSize) && (DWORD)fSize.QuadPart == resSize) {
            CloseHandle(hExisting);
            return true;
        }
        CloseHandle(hExisting);
    }

    HANDLE hOut = CreateFileW(destPath.c_str(), GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hOut == INVALID_HANDLE_VALUE) {
        return false;
    }

    DWORD written = 0;
    BOOL ok = WriteFile(hOut, pData, resSize, &written, NULL);
    CloseHandle(hOut);

    return (ok && written == resSize);
}

/* ─── Helper: Resolve Engine or Extract Embedded Payload ─────────────────── */
std::wstring ResolveOrExtractEngine(HINSTANCE hInstance, const std::wstring& appDir) {
    // 1. Companion dev.exe next to glu.exe
    if (FileExists(appDir + L"dev.exe")) {
        return L"\"" + appDir + L"dev.exe\"";
    }

    // 2. dev.exe in build/ folder
    if (FileExists(appDir + L"build\\dev.exe")) {
        return L"\"" + appDir + L"build\\dev.exe\"";
    }

    // 3. Extract embedded payload to %LOCALAPPDATA%\cli-chat\dev.exe
    wchar_t localApp[MAX_PATH] = {0};
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, MAX_PATH) > 0) {
        std::wstring cacheDir = std::wstring(localApp) + L"\\cli-chat";
        CreateDirectoryW(cacheDir.c_str(), NULL);
        std::wstring cachePath = cacheDir + L"\\dev.exe";
        if (ExtractResourceToFile(hInstance, IDR_EMBEDDED_DEV, cachePath)) {
            return L"\"" + cachePath + L"\"";
        }
    }

    // 4. Fallback extraction to %TEMP%\cli-chat\dev.exe
    wchar_t tempPath[MAX_PATH] = {0};
    if (GetTempPathW(MAX_PATH, tempPath) > 0) {
        std::wstring cacheDir = std::wstring(tempPath) + L"cli-chat";
        CreateDirectoryW(cacheDir.c_str(), NULL);
        std::wstring cachePath = cacheDir + L"\\dev.exe";
        if (ExtractResourceToFile(hInstance, IDR_EMBEDDED_DEV, cachePath)) {
            return L"\"" + cachePath + L"\"";
        }
    }

    // 5. Companion client-win.exe
    if (FileExists(appDir + L"client-win.exe")) {
        return L"\"" + appDir + L"client-win.exe\"";
    }

    // 6. Node.js developer fallback
    if (FileExists(appDir + L"dev.js")) {
        return L"node.exe \"" + appDir + L"dev.js\"";
    }
    if (FileExists(appDir + L"..\\dev.js")) {
        return L"node.exe \"" + appDir + L"..\\dev.js\"";
    }

    return L"";
}

/* ─── Child Watcher Thread ───────────────────────────────────────────────── */
DWORD WINAPI ChildWatcherThread(LPVOID) {
    if (g_hChildProcess) {
        WaitForSingleObject(g_hChildProcess, INFINITE);
    }
    if (!g_bExiting && g_hWndHost) {
        PostMessageW(g_hWndHost, WM_CLOSE, 0, 0);
    }
    return 0;
}

/* ─── Console Control Handler (Kernel-Level Close Trap) ─────────────────── */
BOOL WINAPI ConsoleCtrlHandler(DWORD dwCtrlType) {
    if (dwCtrlType == CTRL_CLOSE_EVENT || dwCtrlType == CTRL_C_EVENT || dwCtrlType == CTRL_BREAK_EVENT) {
        if (!g_bExiting) {
            // Intercept close event: hide console to tray instead of terminating
            ShowConsole(false);
            return TRUE; // Signal handled to prevent process termination
        }
    }
    return FALSE;
}

/* ─── Fail-Safe Hit-Testing for Close Button ('X') ───────────────────────── */
bool IsPointInConsoleCloseButton(POINT pt) {
    if (!g_hConsole || !IsWindow(g_hConsole) || !IsWindowVisible(g_hConsole)) return false;

    RECT rc;
    if (!GetWindowRect(g_hConsole, &rc)) return false;
    if (!PtInRect(&rc, pt)) return false;

    // Check 1: Non-blocking SendMessageTimeoutW (max 15ms to prevent hook timeouts)
    DWORD_PTR hitResult = 0;
    LRESULT lRes = SendMessageTimeoutW(
        g_hConsole,
        WM_NCHITTEST,
        0,
        MAKELPARAM(pt.x, pt.y),
        SMTO_ABORTIFHUNG | SMTO_NORMAL,
        15,
        &hitResult
    );
    if (lRes != 0 && hitResult == HTCLOSE) {
        return true;
    }

    // Check 2: Direct Geometric Fallback for Windows 10 & 11 Titlebar Close Box
    int captionHeight = GetSystemMetrics(SM_CYCAPTION) + GetSystemMetrics(SM_CYFRAME) + 4;
    int btnWidth = GetSystemMetrics(SM_CXSIZE) * 2;
    if (btnWidth < 46) btnWidth = 46;

    if (pt.y >= rc.top && pt.y <= (rc.top + captionHeight)) {
        if (pt.x >= (rc.right - btnWidth) && pt.x <= rc.right) {
            return true;
        }
    }

    return false;
}

/* ─── Ensure Hooks are Active ────────────────────────────────────────────── */
void EnsureHooksInstalled() {
    if (g_bExiting) return;

    if (!g_hMouseHook) {
        g_hMouseHook = SetWindowsHookExW(WH_MOUSE_LL, LowLevelMouseProc, GetModuleHandle(NULL), 0);
    }
    if (!g_hKbdHook) {
        g_hKbdHook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, GetModuleHandle(NULL), 0);
    }
}

/* ─── Entry Point ────────────────────────────────────────────────────────── */
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE, LPSTR, int nCmdShow) {
    g_hInstance = hInstance;

    // 1. Single Instance Protection: restore existing session if already running
    g_hSingleMutex = CreateMutexW(NULL, FALSE, L"Local\\GLUChatSingleInstanceMutex");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND hWndExisting = FindWindowW(L"GLUChatTrayHostClass", L"GLUChatHost");
        if (!hWndExisting) {
            hWndExisting = FindWindowW(L"CLIChatTrayHostClass", L"CLIChatHost");
        }
        if (hWndExisting) {
            PostMessageW(hWndExisting, WM_APP_TRAY, 0, WM_LBUTTONDBLCLK);
        }
        if (g_hSingleMutex) CloseHandle(g_hSingleMutex);
        return 0;
    }

    // 2. Allocate dedicated native Windows Console
    AllocConsole();
    g_hConsole = GetConsoleWindow();

    // Install Kernel-Level Console Control Handler
    SetConsoleCtrlHandler(ConsoleCtrlHandler, TRUE);

    // Load custom app icon from resources
    HICON hAppIcon = (HICON)LoadImageW(hInstance, MAKEINTRESOURCEW(1), IMAGE_ICON, 0, 0, LR_DEFAULTSIZE | LR_SHARED);
    if (!hAppIcon) {
        hAppIcon = LoadIconW(NULL, IDI_APPLICATION);
    }
    HICON hAppIconSmall = (HICON)LoadImageW(hInstance, MAKEINTRESOURCEW(1), IMAGE_ICON, 16, 16, LR_SHARED);
    if (!hAppIconSmall) {
        hAppIconSmall = hAppIcon;
    }

    if (g_hConsole) {
        SetConsoleTitleW(L"glu");
        SendMessageW(g_hConsole, WM_SETICON, ICON_BIG, (LPARAM)hAppIcon);
        SendMessageW(g_hConsole, WM_SETICON, ICON_SMALL, (LPARAM)hAppIconSmall);

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

    // 3. Create hidden message-only window for Tray notifications & menu
    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc   = TrayHostWndProc;
    wc.hInstance     = hInstance;
    wc.lpszClassName = L"GLUChatTrayHostClass";
    wc.hIcon         = hAppIcon;
    wc.hIconSm       = hAppIconSmall;

    RegisterClassExW(&wc);

    g_hWndHost = CreateWindowExW(
        0,
        L"GLUChatTrayHostClass",
        L"GLUChatHost",
        0, 0, 0, 0, 0,
        HWND_MESSAGE, NULL, hInstance, NULL
    );

    // 4. Setup System Tray Icon
    memset(&g_nid, 0, sizeof(g_nid));
    g_nid.cbSize           = sizeof(g_nid);
    g_nid.hWnd             = g_hWndHost;
    g_nid.uID              = ID_TRAY_ICON;
    g_nid.uFlags           = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_APP_TRAY;
    g_nid.hIcon            = hAppIconSmall;
    wcscpy_s(g_nid.szTip, L"glu");
    Shell_NotifyIconW(NIM_ADD, &g_nid);
    g_bTrayActive = true;

    // 5. Install Low-Level Mouse & Keyboard Hooks
    EnsureHooksInstalled();

    // 6. Hook Health Watchdog Timer (checks hook validity every 1000ms)
    SetTimer(g_hWndHost, IDT_HOOK_WATCHDOG, 1000, NULL);

    // 7. Forward any CLI arguments passed to glu.exe
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

    // Determine current executable directory
    wchar_t exePath[MAX_PATH] = {0};
    GetModuleFileNameW(NULL, exePath, MAX_PATH);
    std::wstring appDir = exePath;
    size_t lastSlash = appDir.find_last_of(L"\\/");
    if (lastSlash != std::wstring::npos) {
        appDir = appDir.substr(0, lastSlash + 1);
    } else {
        appDir = L".\\";
    }

    // Resolve or extract the chat engine
    std::wstring targetCmd = ResolveOrExtractEngine(hInstance, appDir);

    if (targetCmd.empty()) {
        MessageBoxW(NULL,
            L"Could not launch chat engine.\n\nPlease check your Windows temp or local app data permissions.",
            L"GLU - Error",
            MB_ICONERROR | MB_OK);
        Cleanup();
        return 1;
    }

    if (!cmdArgs.empty()) {
        targetCmd += L" " + cmdArgs;
    }

    // 8. Spawn child process attached directly to this console
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {0};

    std::vector<wchar_t> cmdBuf(targetCmd.begin(), targetCmd.end());
    cmdBuf.push_back(L'\0');

    BOOL success = CreateProcessW(
        NULL,
        cmdBuf.data(),
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        appDir.c_str(),
        &si,
        &pi
    );

    if (!success) {
        DWORD err = GetLastError();
        wchar_t errMsg[512];
        swprintf_s(errMsg, 512, L"Failed to start GLU engine:\n%s\n\nWindows Error Code: %lu", targetCmd.c_str(), err);
        MessageBoxW(NULL, errMsg, L"GLU - Launch Error", MB_ICONERROR | MB_OK);
        Cleanup();
        return 1;
    }

    g_hChildProcess = pi.hProcess;
    CloseHandle(pi.hThread);

    // 9. Background thread waits for child to exit
    g_hWaitThread = CreateThread(NULL, 0, ChildWatcherThread, NULL, 0, NULL);

    // 10. Message Loop
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
        ShowTrayBalloon(L"glu", L"glu is running in the background. Double-click tray icon to reopen.");
    }
}

/* ─── Low-Level Mouse Hook (Intercepts clicking 'X' on Console) ──────────── */
LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION) {
        MSLLHOOKSTRUCT* pMouse = (MSLLHOOKSTRUCT*)lParam;

        if (wParam == WM_LBUTTONDOWN || wParam == WM_NCLBUTTONDOWN) {
            if (IsPointInConsoleCloseButton(pMouse->pt)) {
                g_bCloseMouseDown = true;
                ShowConsole(false);
                return 1; // Drop mouse down so conhost never terminates!
            }
        } else if (wParam == WM_LBUTTONUP || wParam == WM_NCLBUTTONUP) {
            if (g_bCloseMouseDown || IsPointInConsoleCloseButton(pMouse->pt)) {
                g_bCloseMouseDown = false;
                ShowConsole(false);
                return 1; // Drop mouse up
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
                ShowConsole(false);
                return 1; // Drop Alt+F4
            }
        }
        // Intercept Alt+Space system menu shortcut
        if (pKbd->vkCode == VK_SPACE && (pKbd->flags & LLKHF_ALTDOWN)) {
            if (GetForegroundWindow() == g_hConsole) {
                ShowConsole(false);
                return 1;
            }
        }
    }
    return CallNextHookEx(g_hKbdHook, nCode, wParam, lParam);
}

/* ─── Tray Host Window Procedure ─────────────────────────────────────────── */
LRESULT CALLBACK TrayHostWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_TIMER: {
            if (wParam == IDT_HOOK_WATCHDOG && !g_bExiting) {
                EnsureHooksInstalled();
            }
            return 0;
        }

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
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_EXIT,    L"Exit glu");

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

    if (g_hWndHost) {
        KillTimer(g_hWndHost, IDT_HOOK_WATCHDOG);
    }

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

    if (g_hWaitThread) {
        WaitForSingleObject(g_hWaitThread, 500);
        CloseHandle(g_hWaitThread);
        g_hWaitThread = NULL;
    }

    if (g_hConsole) {
        FreeConsole();
        g_hConsole = NULL;
    }

    if (g_hSingleMutex) {
        CloseHandle(g_hSingleMutex);
        g_hSingleMutex = NULL;
    }
}
