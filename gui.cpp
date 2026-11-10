/**
 * CLI Chat - Native CMD Terminal GUI with Close-to-Tray
 *
 * Looks and behaves exactly like running dev.js in CMD:
 *  - Authentic command-prompt dark styling (black #0C0C0C, Consolas font, ANSI colors)
 *  - Native terminal prompt and input flow with Up/Down command history
 *  - Forwards all CLI flags/arguments directly to dev.js
 *  - Intercepts 'X' (close) to minimize to Windows System Tray instead of exiting
 *  - Double-click tray icon to restore, right-click menu for Show / Hide / Quit
 *  - Tray balloon alerts for incoming messages and file transfers while hidden
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <richedit.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <sstream>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

/* ─── Control IDs & Messages ─────────────────────────────────────────────── */
#define ID_RICHEDIT_TERMINAL 1001
#define ID_EDIT_INPUT        1002
#define ID_LBL_PROMPT        1003

#define ID_TRAY_ICON         2001
#define ID_TRAY_RESTORE      2002
#define ID_TRAY_HIDE         2003
#define ID_TRAY_EXIT         2004

#define WM_APP_TRAY          (WM_APP + 1)
#define WM_APP_ADD_CHUNK     (WM_APP + 2)
#define WM_APP_CHILD_EXIT    (WM_APP + 3)

/* ─── CMD Color Palette ─────────────────────────────────────────────────── */
static const COLORREF COLOR_BG          = RGB(12, 12, 12);     // CMD Black (#0C0C0C)
static const COLORREF COLOR_DEFAULT_TXT = RGB(204, 204, 204); // CMD Off-White (#CCCCCC)
static const COLORREF COLOR_PROMPT_TXT  = RGB(19, 161, 14);   // CMD Bright Green (#13A10E)
static const COLORREF COLOR_CYAN        = RGB(97, 214, 214);  // CMD Cyan
static const COLORREF COLOR_GREEN       = RGB(19, 161, 14);   // CMD Green
static const COLORREF COLOR_BLUE        = RGB(59, 120, 255);  // CMD Blue
static const COLORREF COLOR_MAGENTA     = RGB(180, 0, 158);   // CMD Magenta
static const COLORREF COLOR_YELLOW      = RGB(249, 241, 165); // CMD Yellow
static const COLORREF COLOR_GRAY        = RGB(118, 118, 118); // CMD Dim Gray
static const COLORREF COLOR_RED         = RGB(231, 72, 86);   // CMD Red

/* ─── Global State ───────────────────────────────────────────────────────── */
static HINSTANCE        g_hInstance      = NULL;
static HWND             g_hWndMain       = NULL;
static HWND             g_hTerminalEdit  = NULL;
static HWND             g_hInputEdit     = NULL;
static HWND             g_hPromptLbl     = NULL;

static HFONT            g_hFontConsole   = NULL;
static HFONT            g_hFontBold      = NULL;
static HBRUSH           g_hBrushBg       = NULL;

static NOTIFYICONDATAW  g_nid            = {0};
static bool             g_bTrayActive    = false;
static bool             g_bExiting       = false;

/* Child Process Handles */
static HANDLE           g_hChildProcess  = NULL;
static HANDLE           g_hChildStdinWr  = NULL;
static HANDLE           g_hChildStdoutRd = NULL;
static std::thread*     g_pReaderThread  = nullptr;
static std::atomic<bool> g_bChildRunning(false);

/* Command History */
static std::vector<std::wstring> g_cmdHistory;
static int              g_historyIndex   = -1;
static WNDPROC          g_pOrigInputProc = NULL;

/* ANSI Parser State */
struct AnsiState {
    COLORREF color = COLOR_DEFAULT_TXT;
    bool bold      = false;
} g_ansiState;

/* ─── Forward Declarations ───────────────────────────────────────────────── */
LRESULT CALLBACK WndProc(HWND, UINT, WPARAM, LPARAM);
LRESULT CALLBACK InputSubclassProc(HWND, UINT, WPARAM, LPARAM);
void ProcessAnsiChunk(HWND hEdit, const std::string& chunk);
void AppendTextWithFormat(HWND hEdit, const std::wstring& text, COLORREF color, bool bold);
void LaunchNodeProcess(const std::wstring& cmdArgs);
void TerminateChildProcess();
void SendLineToChild(const std::wstring& line);
void ShowTrayBalloon(const std::wstring& title, const std::wstring& msg);
std::wstring Trim(const std::wstring& s);

/* ─── Entry Point ────────────────────────────────────────────────────────── */
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE, LPSTR, int nCmdShow) {
    g_hInstance = hInstance;

    // Load RichEdit 2.0/4.1
    HMODULE hRichLib = LoadLibraryA("msftedit.dll");
    if (!hRichLib) {
        LoadLibraryA("riched20.dll");
    }

    INITCOMMONCONTROLSEX icex = { sizeof(icex), ICC_STANDARD_CLASSES | ICC_WIN95_CLASSES };
    InitCommonControlsEx(&icex);

    g_hBrushBg = CreateSolidBrush(COLOR_BG);

    // Authentic CMD Console Font: Consolas 15px
    g_hFontConsole = CreateFontW(17, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                CLEARTYPE_QUALITY, FIXED_PITCH | FF_MODERN, L"Consolas");
    g_hFontBold    = CreateFontW(17, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                CLEARTYPE_QUALITY, FIXED_PITCH | FF_MODERN, L"Consolas");

    // Register Window Class
    WNDCLASSEXW wc = { sizeof(wc) };
    wc.cbClsExtra    = 0;
    wc.cbWndExtra    = 0;
    wc.hbrBackground = g_hBrushBg;
    wc.hCursor       = LoadCursor(NULL, IDC_ARROW);
    wc.hIcon         = LoadIcon(NULL, IDI_APPLICATION);
    wc.hIconSm       = LoadIcon(NULL, IDI_APPLICATION);
    wc.hInstance     = hInstance;
    wc.lpfnWndProc   = WndProc;
    wc.lpszClassName = L"CLIChatCmdClass";
    wc.style         = CS_HREDRAW | CS_VREDRAW;

    if (!RegisterClassExW(&wc)) return 1;

    // Create Main Window (Styled like CMD Console)
    HWND hWnd = CreateWindowExW(
        WS_EX_APPWINDOW,
        L"CLIChatCmdClass",
        L"cli-chat (dev)",
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        CW_USEDEFAULT, CW_USEDEFAULT,
        840, 560,
        NULL, NULL, hInstance, NULL
    );

    if (!hWnd) return 1;
    g_hWndMain = hWnd;

    // System Tray Setup
    memset(&g_nid, 0, sizeof(g_nid));
    g_nid.cbSize           = sizeof(g_nid);
    g_nid.hWnd             = hWnd;
    g_nid.uID              = ID_TRAY_ICON;
    g_nid.uFlags           = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_APP_TRAY;
    g_nid.hIcon            = LoadIcon(NULL, IDI_APPLICATION);
    wcscpy_s(g_nid.szTip, L"cli-chat (dev)");
    Shell_NotifyIconW(NIM_ADD, &g_nid);
    g_bTrayActive = true;

    ShowWindow(hWnd, nCmdShow);
    UpdateWindow(hWnd);

    // Forward all command line arguments to dev.js
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

    LaunchNodeProcess(cmdArgs);
    SetFocus(g_hInputEdit);

    // Message Loop
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_bTrayActive) {
        Shell_NotifyIconW(NIM_DELETE, &g_nid);
        g_bTrayActive = false;
    }

    TerminateChildProcess();

    if (g_hFontConsole) DeleteObject(g_hFontConsole);
    if (g_hFontBold)    DeleteObject(g_hFontBold);
    if (g_hBrushBg)     DeleteObject(g_hBrushBg);

    return (int)msg.wParam;
}

/* ─── Window Procedure ───────────────────────────────────────────────────── */
LRESULT CALLBACK WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CREATE: {
            // Upper Terminal Log Area (RichEdit, pure black, no border, Consolas font)
            g_hTerminalEdit = CreateWindowExW(0, L"RichEdit50W", L"",
                WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
                8, 6, 808, 480, hWnd, (HMENU)ID_RICHEDIT_TERMINAL, g_hInstance, NULL);

            if (!g_hTerminalEdit) {
                // Fallback to RichEdit20W
                g_hTerminalEdit = CreateWindowExW(0, RICHEDIT_CLASSW, L"",
                    WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
                    8, 6, 808, 480, hWnd, (HMENU)ID_RICHEDIT_TERMINAL, g_hInstance, NULL);
            }

            // Bottom Prompt Indicator (e.g. ">")
            g_hPromptLbl = CreateWindowExW(0, L"STATIC", L">",
                WS_CHILD | WS_VISIBLE | SS_LEFT,
                8, 492, 16, 24, hWnd, (HMENU)ID_LBL_PROMPT, g_hInstance, NULL);

            // Bottom Command Prompt Input (Border-free, black background, white text)
            g_hInputEdit = CreateWindowExW(0, L"EDIT", L"",
                WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                26, 492, 790, 24, hWnd, (HMENU)ID_EDIT_INPUT, g_hInstance, NULL);

            SendMessageW(g_hTerminalEdit, WM_SETFONT, (WPARAM)g_hFontConsole, TRUE);
            SendMessageW(g_hPromptLbl,    WM_SETFONT, (WPARAM)g_hFontBold,    TRUE);
            SendMessageW(g_hInputEdit,    WM_SETFONT, (WPARAM)g_hFontConsole, TRUE);

            SendMessageW(g_hTerminalEdit, EM_SETBKGNDCOLOR, 0, (LPARAM)COLOR_BG);
            SendMessageW(g_hTerminalEdit, EM_AUTOURLDETECT, TRUE, 0);

            // Subclass Input for Enter submission and Up/Down history
            g_pOrigInputProc = (WNDPROC)SetWindowLongPtrW(g_hInputEdit, GWLP_WNDPROC, (LONG_PTR)InputSubclassProc);
            return 0;
        }

        case WM_SIZE: {
            int width  = LOWORD(lParam);
            int height = HIWORD(lParam);

            int inputH = 26;
            int inputY = height - inputH - 6;
            int logH   = inputY - 8;
            if (logH < 50) logH = 50;

            MoveWindow(g_hTerminalEdit, 8, 6, width - 16, logH, TRUE);
            MoveWindow(g_hPromptLbl,    8, inputY, 18, inputH, TRUE);
            MoveWindow(g_hInputEdit,    28, inputY, width - 38, inputH, TRUE);
            return 0;
        }

        case WM_CTLCOLORSTATIC: {
            HDC hdc = (HDC)wParam;
            SetBkMode(hdc, OPAQUE);
            SetBkColor(hdc, COLOR_BG);
            SetTextColor(hdc, COLOR_PROMPT_TXT);
            return (LRESULT)g_hBrushBg;
        }

        case WM_CTLCOLOREDIT: {
            HDC hdc = (HDC)wParam;
            SetBkMode(hdc, OPAQUE);
            SetBkColor(hdc, COLOR_BG);
            SetTextColor(hdc, COLOR_DEFAULT_TXT);
            return (LRESULT)g_hBrushBg;
        }

        case WM_SETFOCUS: {
            SetFocus(g_hInputEdit);
            return 0;
        }

        // Close Button Clicked: MINIMIZE TO TRAY!
        case WM_CLOSE: {
            ShowWindow(hWnd, SW_HIDE);
            ShowTrayBalloon(L"cli-chat (dev)", L"cli-chat is still running in the background. Double-click tray icon to restore.");
            return 0;
        }

        // Tray Icon Events
        case WM_APP_TRAY: {
            if (lParam == WM_LBUTTONDBLCLK) {
                ShowWindow(hWnd, SW_RESTORE);
                SetForegroundWindow(hWnd);
                SetFocus(g_hInputEdit);
            }
            else if (lParam == WM_RBUTTONUP) {
                POINT pt;
                GetCursorPos(&pt);
                HMENU hMenu = CreatePopupMenu();
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_RESTORE, L"Show Terminal");
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_HIDE,    L"Hide to Tray");
                AppendMenuW(hMenu, MF_SEPARATOR, 0, NULL);
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_EXIT,    L"Quit cli-chat");

                SetForegroundWindow(hWnd);
                int cmd = TrackPopupMenu(hMenu, TPM_RETURNCMD | TPM_NONOTIFY, pt.x, pt.y, 0, hWnd, NULL);
                DestroyMenu(hMenu);

                if (cmd == ID_TRAY_RESTORE) {
                    ShowWindow(hWnd, SW_RESTORE);
                    SetForegroundWindow(hWnd);
                    SetFocus(g_hInputEdit);
                } else if (cmd == ID_TRAY_HIDE) {
                    ShowWindow(hWnd, SW_HIDE);
                } else if (cmd == ID_TRAY_EXIT) {
                    g_bExiting = true;
                    DestroyWindow(hWnd);
                }
            }
            return 0;
        }

        // Output from child process
        case WM_APP_ADD_CHUNK: {
            std::string* pChunk = (std::string*)lParam;
            if (pChunk) {
                ProcessAnsiChunk(g_hTerminalEdit, *pChunk);

                // Show desktop balloon if hidden in tray
                if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) {
                    if (pChunk->find(": ") != std::string::npos &&
                        pChunk->find("[System]") == std::string::npos) {
                        ShowTrayBalloon(L"cli-chat", L"New message received");
                    } else if (pChunk->find("is sending") != std::string::npos) {
                        ShowTrayBalloon(L"File Transfer", L"Incoming file transfer");
                    }
                }

                delete pChunk;
            }
            return 0;
        }

        case WM_APP_CHILD_EXIT: {
            AppendTextWithFormat(g_hTerminalEdit, L"\n[Process exited]\n", COLOR_GRAY, false);
            return 0;
        }

        case WM_DESTROY: {
            if (g_bTrayActive) {
                Shell_NotifyIconW(NIM_DELETE, &g_nid);
                g_bTrayActive = false;
            }
            PostQuitMessage(0);
            return 0;
        }
    }
    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

/* ─── Input Subclass (Enter to Send, Up/Down for History) ─────────────────── */
LRESULT CALLBACK InputSubclassProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_KEYDOWN) {
        if (wParam == VK_RETURN) {
            int len = GetWindowTextLengthW(hWnd);
            std::vector<wchar_t> buf(len + 1);
            GetWindowTextW(hWnd, buf.data(), len + 1);
            std::wstring line = buf.data();

            SetWindowTextW(hWnd, L"");

            // Echo line to terminal (like CMD)
            AppendTextWithFormat(g_hTerminalEdit, line + L"\n", COLOR_DEFAULT_TXT, false);

            // Send to node dev.js stdin
            SendLineToChild(line);

            if (!line.empty()) {
                g_cmdHistory.push_back(line);
                g_historyIndex = (int)g_cmdHistory.size();
            }
            return 0;
        }
        else if (wParam == VK_UP) {
            if (!g_cmdHistory.empty() && g_historyIndex > 0) {
                g_historyIndex--;
                SetWindowTextW(hWnd, g_cmdHistory[g_historyIndex].c_str());
                SendMessageW(hWnd, EM_SETSEL, -1, -1);
            }
            return 0;
        }
        else if (wParam == VK_DOWN) {
            if (!g_cmdHistory.empty() && g_historyIndex < (int)g_cmdHistory.size() - 1) {
                g_historyIndex++;
                SetWindowTextW(hWnd, g_cmdHistory[g_historyIndex].c_str());
                SendMessageW(hWnd, EM_SETSEL, -1, -1);
            } else if (g_historyIndex == (int)g_cmdHistory.size() - 1) {
                g_historyIndex = (int)g_cmdHistory.size();
                SetWindowTextW(hWnd, L"");
            }
            return 0;
        }
    }
    return CallWindowProcW(g_pOrigInputProc, hWnd, msg, wParam, lParam);
}

/* ─── RichEdit Formatting & ANSI Terminal Color Engine ───────────────────── */
void AppendTextWithFormat(HWND hEdit, const std::wstring& text, COLORREF color, bool bold) {
    if (!hEdit || text.empty()) return;

    CHARRANGE cr;
    cr.cpMin = -1;
    cr.cpMax = -1;
    SendMessageW(hEdit, EM_EXSETSEL, 0, (LPARAM)&cr);

    CHARFORMAT2W cf;
    memset(&cf, 0, sizeof(cf));
    cf.cbSize      = sizeof(cf);
    cf.dwMask      = CFM_COLOR | CFM_BOLD;
    cf.crTextColor = color;
    cf.dwEffects   = bold ? CFE_BOLD : 0;

    SendMessageW(hEdit, EM_SETCHARFORMAT, SCF_SELECTION, (LPARAM)&cf);
    SendMessageW(hEdit, EM_REPLACESEL, FALSE, (LPARAM)text.c_str());
    SendMessageW(hEdit, WM_VSCROLL, SB_BOTTOM, 0);
}

void ProcessAnsiChunk(HWND hEdit, const std::string& chunk) {
    if (!hEdit || chunk.empty()) return;

    size_t i = 0;
    std::string textBuf;

    auto flushBuffer = [&]() {
        if (textBuf.empty()) return;
        int needed = MultiByteToWideChar(CP_UTF8, 0, textBuf.c_str(), (int)textBuf.length(), NULL, 0);
        if (needed > 0) {
            std::wstring wText(needed, 0);
            MultiByteToWideChar(CP_UTF8, 0, textBuf.c_str(), (int)textBuf.length(), &wText[0], needed);
            AppendTextWithFormat(hEdit, wText, g_ansiState.color, g_ansiState.bold);
        }
        textBuf.clear();
    };

    while (i < chunk.size()) {
        if (chunk[i] == '\x1B' && i + 1 < chunk.size() && chunk[i + 1] == '[') {
            flushBuffer();
            i += 2; // skip ESC [
            std::string codeStr;
            while (i < chunk.size() && (chunk[i] == ';' || (chunk[i] >= '0' && chunk[i] <= '9'))) {
                codeStr += chunk[i++];
            }
            if (i < chunk.size() && chunk[i] == 'm') {
                i++; // skip 'm'
                // Parse code
                int code = codeStr.empty() ? 0 : atoi(codeStr.c_str());
                switch (code) {
                    case 0:
                        g_ansiState.color = COLOR_DEFAULT_TXT;
                        g_ansiState.bold  = false;
                        break;
                    case 1:
                        g_ansiState.bold  = true;
                        break;
                    case 2:
                        g_ansiState.color = COLOR_GRAY;
                        break;
                    case 31:
                        g_ansiState.color = COLOR_RED;
                        break;
                    case 32:
                        g_ansiState.color = COLOR_GREEN;
                        break;
                    case 33:
                        g_ansiState.color = COLOR_YELLOW;
                        break;
                    case 34:
                        g_ansiState.color = COLOR_BLUE;
                        break;
                    case 35:
                        g_ansiState.color = COLOR_MAGENTA;
                        break;
                    case 36:
                        g_ansiState.color = COLOR_CYAN;
                        break;
                    case 90:
                        g_ansiState.color = COLOR_GRAY;
                        break;
                    default:
                        break;
                }
            }
        } else if (chunk[i] == '\r') {
            // Carriage return without newline
            i++;
        } else {
            textBuf += chunk[i++];
        }
    }
    flushBuffer();
}

/* ─── Node Process Management ────────────────────────────────────────────── */
void LaunchNodeProcess(const std::wstring& cmdArgs) {
    TerminateChildProcess();

    HANDLE hStdInRd  = NULL;
    HANDLE hStdInWr  = NULL;
    HANDLE hStdOutRd = NULL;
    HANDLE hStdOutWr = NULL;

    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };

    if (!CreatePipe(&hStdInRd, &hStdInWr, &sa, 0)) return;
    SetHandleInformation(hStdInWr, HANDLE_FLAG_INHERIT, 0);

    if (!CreatePipe(&hStdOutRd, &hStdOutWr, &sa, 0)) {
        CloseHandle(hStdInRd);
        CloseHandle(hStdInWr);
        return;
    }
    SetHandleInformation(hStdOutRd, HANDLE_FLAG_INHERIT, 0);

    g_hChildStdinWr  = hStdInWr;
    g_hChildStdoutRd = hStdOutRd;

    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags     = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput   = hStdInRd;
    si.hStdOutput  = hStdOutWr;
    si.hStdError   = hStdOutWr;

    PROCESS_INFORMATION pi = {0};

    // Command line: node.exe dev.js <args>
    std::wstring cmd = L"node.exe dev.js";
    if (!cmdArgs.empty()) {
        cmd += L" " + cmdArgs;
    }

    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');

    BOOL success = CreateProcessW(
        NULL,
        cmdBuf.data(),
        NULL,
        NULL,
        TRUE,
        CREATE_NO_WINDOW,
        NULL,
        NULL,
        &si,
        &pi
    );

    CloseHandle(hStdInRd);
    CloseHandle(hStdOutWr);

    if (!success) {
        CloseHandle(hStdInWr);
        CloseHandle(hStdOutRd);
        g_hChildStdinWr = NULL;
        g_hChildStdoutRd = NULL;
        AppendTextWithFormat(g_hTerminalEdit, L"[Error] Failed to launch node.exe dev.js\n", COLOR_RED, true);
        return;
    }

    g_hChildProcess = pi.hProcess;
    CloseHandle(pi.hThread);
    g_bChildRunning.store(true);

    // Background thread streams stdout chunk-by-chunk to the terminal
    g_pReaderThread = new std::thread([]() {
        HANDLE hRead = g_hChildStdoutRd;
        char buffer[2048];
        DWORD bytesRead = 0;

        while (ReadFile(hRead, buffer, sizeof(buffer) - 1, &bytesRead, NULL) && bytesRead > 0) {
            buffer[bytesRead] = '\0';
            std::string* pChunk = new std::string(buffer, bytesRead);
            PostMessageW(g_hWndMain, WM_APP_ADD_CHUNK, 0, (LPARAM)pChunk);
        }

        g_bChildRunning.store(false);
        PostMessageW(g_hWndMain, WM_APP_CHILD_EXIT, 0, 0);
    });
}

void TerminateChildProcess() {
    g_bChildRunning.store(false);

    if (g_hChildStdinWr) {
        DWORD written = 0;
        WriteFile(g_hChildStdinWr, "/quit\n", 6, &written, NULL);
        CloseHandle(g_hChildStdinWr);
        g_hChildStdinWr = NULL;
    }

    if (g_hChildProcess) {
        if (WaitForSingleObject(g_hChildProcess, 1000) == WAIT_TIMEOUT) {
            TerminateProcess(g_hChildProcess, 0);
        }
        CloseHandle(g_hChildProcess);
        g_hChildProcess = NULL;
    }

    if (g_hChildStdoutRd) {
        CloseHandle(g_hChildStdoutRd);
        g_hChildStdoutRd = NULL;
    }

    if (g_pReaderThread) {
        if (g_pReaderThread->joinable()) {
            g_pReaderThread->join();
        }
        delete g_pReaderThread;
        g_pReaderThread = nullptr;
    }
}

void SendLineToChild(const std::wstring& line) {
    if (!g_hChildStdinWr || !g_bChildRunning.load()) return;

    int needed = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.length(), NULL, 0, NULL, NULL);
    if (needed < 0) return;

    std::string utf8(needed, 0);
    if (needed > 0) {
        WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.length(), &utf8[0], needed, NULL, NULL);
    }
    utf8 += "\n";

    DWORD written = 0;
    WriteFile(g_hChildStdinWr, utf8.c_str(), (DWORD)utf8.length(), &written, NULL);
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
