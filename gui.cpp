/**
 * CLI Chat - Mini GUI Host for Windows
 * Native Win32 GUI companion for dev.js with System Tray integration.
 *
 * Features:
 *  - Hides to System Tray on close ('X' button) instead of terminating
 *  - Tray icon with double-click restore, right-click context menu
 *  - Tray balloon notifications for incoming messages and file transfers
 *  - Dark-mode RichEdit chat log with color-coded messages
 *  - Native file picker button for /send
 *  - Auto-scroll, command history, and persistent config (gui_config.ini)
 *  - Zero runtime dependencies, standalone native binary (~150 KB)
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
#include <commdlg.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <fstream>
#include <sstream>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

/* ─── Control IDs ────────────────────────────────────────────────────────── */
#define ID_RICHEDIT_LOG      1001
#define ID_EDIT_INPUT        1002
#define ID_BTN_SEND          1003
#define ID_BTN_FILE          1004
#define ID_EDIT_USER         1005
#define ID_EDIT_ROOM         1006
#define ID_BTN_CONNECT       1007
#define ID_BTN_USERS         1008

#define ID_TRAY_ICON         2001
#define ID_TRAY_RESTORE      2002
#define ID_TRAY_HIDE         2003
#define ID_TRAY_SENDFILE     2004
#define ID_TRAY_EXIT         2005

/* ─── Custom Window Messages ─────────────────────────────────────────────── */
#define WM_APP_TRAY          (WM_APP + 1)
#define WM_APP_ADD_LOG       (WM_APP + 2)
#define WM_APP_CHILD_EXIT    (WM_APP + 3)

/* ─── Global Handles & State ─────────────────────────────────────────────── */
static HINSTANCE        g_hInstance      = NULL;
static HWND             g_hWndMain       = NULL;
static HWND             g_hRichEdit      = NULL;
static HWND             g_hEditInput     = NULL;
static HWND             g_hBtnSend       = NULL;
static HWND             g_hBtnFile       = NULL;
static HWND             g_hEditUser      = NULL;
static HWND             g_hEditRoom      = NULL;
static HWND             g_hBtnConnect    = NULL;
static HWND             g_hBtnUsers      = NULL;
static HWND             g_hLblUser       = NULL;
static HWND             g_hLblRoom       = NULL;
static HWND             g_hLblStatus     = NULL;

static HFONT            g_hFontMono      = NULL;
static HFONT            g_hFontUi        = NULL;
static HFONT            g_hFontBold      = NULL;
static HBRUSH           g_hBrushBg       = NULL;
static HBRUSH           g_hBrushPanel    = NULL;
static HBRUSH           g_hBrushInput    = NULL;

static NOTIFYICONDATAW  g_nid            = {0};
static bool             g_bTrayActive    = false;
static bool             g_bExiting       = false;
static bool             g_bBalloonShown  = false;

/* Process Handles */
static HANDLE           g_hChildProcess  = NULL;
static HANDLE           g_hChildStdinWr  = NULL;
static HANDLE           g_hChildStdoutRd = NULL;
static std::thread*     g_pReaderThread  = nullptr;
static std::atomic<bool> g_bChildRunning(false);

/* App State */
static std::wstring     g_wsUser;
static std::wstring     g_wsRoom;
static std::vector<std::wstring> g_cmdHistory;
static int              g_historyIndex   = -1;

/* Original Subclass WndProc for Input */
static WNDPROC          g_pOrigInputProc = NULL;

/* ─── Forward Declarations ───────────────────────────────────────────────── */
LRESULT CALLBACK WndProc(HWND, UINT, WPARAM, LPARAM);
LRESULT CALLBACK InputSubclassProc(HWND, UINT, WPARAM, LPARAM);
void AppendFormattedLog(HWND hEdit, const std::wstring& line);
void LaunchNodeProcess(const std::wstring& user, const std::wstring& room);
void TerminateChildProcess();
void SendLineToChild(const std::wstring& text);
void LoadConfigFile();
void SaveConfigFile();
void ShowTrayBalloon(const std::wstring& title, const std::wstring& msg);
std::wstring Trim(const std::wstring& s);
std::wstring StripAnsi(const std::string& input);

/* ─── Entry Point ────────────────────────────────────────────────────────── */
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE, LPSTR, int nCmdShow) {
    g_hInstance = hInstance;

    // Load RichEdit library
    HMODULE hRichLib = LoadLibraryA("riched20.dll");
    if (!hRichLib) {
        LoadLibraryA("msftedit.dll");
    }

    INITCOMMONCONTROLSEX icex = { sizeof(icex), ICC_STANDARD_CLASSES | ICC_WIN95_CLASSES };
    InitCommonControlsEx(&icex);

    // Create custom brushes (Dark theme)
    g_hBrushBg    = CreateSolidBrush(RGB(24, 25, 32));   // #181920
    g_hBrushPanel = CreateSolidBrush(RGB(30, 31, 41));   // #1E1F29
    g_hBrushInput = CreateSolidBrush(RGB(40, 42, 54));   // #282A36

    // Fonts
    g_hFontMono = CreateFontW(16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, FIXED_PITCH | FF_MODERN, L"Consolas");
    g_hFontUi   = CreateFontW(15, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, VARIABLE_PITCH | FF_SWISS, L"Segoe UI");
    g_hFontBold = CreateFontW(15, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, VARIABLE_PITCH | FF_SWISS, L"Segoe UI");

    // Load saved settings (Username / Room)
    LoadConfigFile();

    // Check command line overrides
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv) {
        for (int i = 1; i < argc; ++i) {
            std::wstring arg = argv[i];
            if ((arg == L"--user" || arg == L"-u") && i + 1 < argc) {
                g_wsUser = argv[++i];
            } else if ((arg == L"--room" || arg == L"-r") && i + 1 < argc) {
                g_wsRoom = argv[++i];
            }
        }
        LocalFree(argv);
    }

    if (g_wsRoom.empty()) {
        g_wsRoom = L"6767";
    }

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
    wc.lpszClassName = L"CLIChatGuiClass";
    wc.style         = CS_HREDRAW | CS_VREDRAW;

    if (!RegisterClassExW(&wc)) {
        return 1;
    }

    // Main Window
    HWND hWnd = CreateWindowExW(
        WS_EX_APPWINDOW,
        L"CLIChatGuiClass",
        L"CLI Chat - api.cfat.site",
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        CW_USEDEFAULT, CW_USEDEFAULT,
        820, 620,
        NULL, NULL, hInstance, NULL
    );

    if (!hWnd) return 1;
    g_hWndMain = hWnd;

    // Setup System Tray Icon
    memset(&g_nid, 0, sizeof(g_nid));
    g_nid.cbSize           = sizeof(g_nid);
    g_nid.hWnd             = hWnd;
    g_nid.uID              = ID_TRAY_ICON;
    g_nid.uFlags           = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_APP_TRAY;
    g_nid.hIcon            = LoadIcon(NULL, IDI_APPLICATION);
    wcscpy_s(g_nid.szTip, L"CLI Chat - Online");
    Shell_NotifyIconW(NIM_ADD, &g_nid);
    g_bTrayActive = true;

    ShowWindow(hWnd, nCmdShow);
    UpdateWindow(hWnd);

    // If username is provided, connect automatically!
    if (!g_wsUser.empty()) {
        LaunchNodeProcess(g_wsUser, g_wsRoom);
    } else {
        SetFocus(g_hEditUser);
    }

    // Message Loop
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    // Cleanup Tray
    if (g_bTrayActive) {
        Shell_NotifyIconW(NIM_DELETE, &g_nid);
        g_bTrayActive = false;
    }

    TerminateChildProcess();

    if (g_hFontMono)  DeleteObject(g_hFontMono);
    if (g_hFontUi)    DeleteObject(g_hFontUi);
    if (g_hFontBold)  DeleteObject(g_hFontBold);
    if (g_hBrushBg)   DeleteObject(g_hBrushBg);
    if (g_hBrushPanel)DeleteObject(g_hBrushPanel);
    if (g_hBrushInput)DeleteObject(g_hBrushInput);

    return (int)msg.wParam;
}

/* ─── Main Window Procedure ──────────────────────────────────────────────── */
LRESULT CALLBACK WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CREATE: {
            // Top Bar Controls (Username, Room, Connect, Users)
            g_hLblUser = CreateWindowExW(0, L"STATIC", L"User:", WS_CHILD | WS_VISIBLE | SS_LEFT,
                15, 12, 40, 22, hWnd, NULL, g_hInstance, NULL);

            g_hEditUser = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", g_wsUser.c_str(),
                WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                58, 10, 140, 24, hWnd, (HMENU)ID_EDIT_USER, g_hInstance, NULL);

            g_hLblRoom = CreateWindowExW(0, L"STATIC", L"Room:", WS_CHILD | WS_VISIBLE | SS_LEFT,
                210, 12, 45, 22, hWnd, NULL, g_hInstance, NULL);

            g_hEditRoom = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", g_wsRoom.c_str(),
                WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                258, 10, 100, 24, hWnd, (HMENU)ID_EDIT_ROOM, g_hInstance, NULL);

            g_hBtnConnect = CreateWindowExW(0, L"BUTTON", L"Connect", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                370, 10, 90, 24, hWnd, (HMENU)ID_BTN_CONNECT, g_hInstance, NULL);

            g_hBtnUsers = CreateWindowExW(0, L"BUTTON", L"Online Users", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                468, 10, 110, 24, hWnd, (HMENU)ID_BTN_USERS, g_hInstance, NULL);

            g_hLblStatus = CreateWindowExW(0, L"STATIC", L"Ready to connect", WS_CHILD | WS_VISIBLE | SS_RIGHT,
                590, 12, 200, 22, hWnd, NULL, g_hInstance, NULL);

            // RichEdit Chat Area
            g_hRichEdit = CreateWindowExW(WS_EX_CLIENTEDGE, RICHEDIT_CLASSW, L"",
                WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
                15, 45, 775, 490, hWnd, (HMENU)ID_RICHEDIT_LOG, g_hInstance, NULL);

            // Bottom Input Bar
            g_hEditInput = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                15, 545, 595, 26, hWnd, (HMENU)ID_EDIT_INPUT, g_hInstance, NULL);

            g_hBtnSend = CreateWindowExW(0, L"BUTTON", L"Send", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
                618, 545, 80, 26, hWnd, (HMENU)ID_BTN_SEND, g_hInstance, NULL);

            g_hBtnFile = CreateWindowExW(0, L"BUTTON", L"Send File...", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                706, 545, 95, 26, hWnd, (HMENU)ID_BTN_FILE, g_hInstance, NULL);

            // Set Fonts
            SendMessageW(g_hLblUser,    WM_SETFONT, (WPARAM)g_hFontBold, TRUE);
            SendMessageW(g_hEditUser,   WM_SETFONT, (WPARAM)g_hFontUi,   TRUE);
            SendMessageW(g_hLblRoom,    WM_SETFONT, (WPARAM)g_hFontBold, TRUE);
            SendMessageW(g_hEditRoom,   WM_SETFONT, (WPARAM)g_hFontUi,   TRUE);
            SendMessageW(g_hBtnConnect, WM_SETFONT, (WPARAM)g_hFontUi,   TRUE);
            SendMessageW(g_hBtnUsers,   WM_SETFONT, (WPARAM)g_hFontUi,   TRUE);
            SendMessageW(g_hLblStatus,  WM_SETFONT, (WPARAM)g_hFontUi,   TRUE);
            SendMessageW(g_hRichEdit,   WM_SETFONT, (WPARAM)g_hFontMono, TRUE);
            SendMessageW(g_hEditInput,  WM_SETFONT, (WPARAM)g_hFontMono, TRUE);
            SendMessageW(g_hBtnSend,    WM_SETFONT, (WPARAM)g_hFontUi,   TRUE);
            SendMessageW(g_hBtnFile,    WM_SETFONT, (WPARAM)g_hFontUi,   TRUE);

            // RichEdit Background & Options
            SendMessageW(g_hRichEdit, EM_SETBKGNDCOLOR, 0, (LPARAM)RGB(24, 25, 32));
            SendMessageW(g_hRichEdit, EM_AUTOURLDETECT, TRUE, 0);

            // Subclass the Input Box for Enter key handling & Command History
            g_pOrigInputProc = (WNDPROC)SetWindowLongPtrW(g_hEditInput, GWLP_WNDPROC, (LONG_PTR)InputSubclassProc);

            // Welcome banner in log
            AppendFormattedLog(g_hRichEdit, L"[System] Welcome to CLI Chat GUI! (CFAT Edge Relay: api.cfat.site)\n");
            AppendFormattedLog(g_hRichEdit, L"[System] Tip: Closing this window will minimize to system tray.\n\n");
            return 0;
        }

        case WM_SIZE: {
            int width  = LOWORD(lParam);
            int height = HIWORD(lParam);

            // Top bar positioning
            MoveWindow(g_hLblStatus, width - 215, 12, 200, 22, TRUE);

            // Bottom bar positioning
            int bottomY = height - 42;
            int fileBtnW = 95;
            int sendBtnW = 75;
            int spacing  = 8;

            int inputW = width - 30 - fileBtnW - sendBtnW - (spacing * 2);
            if (inputW < 100) inputW = 100;

            MoveWindow(g_hEditInput, 15, bottomY, inputW, 26, TRUE);
            MoveWindow(g_hBtnSend, 15 + inputW + spacing, bottomY, sendBtnW, 26, TRUE);
            MoveWindow(g_hBtnFile, 15 + inputW + spacing + sendBtnW + spacing, bottomY, fileBtnW, 26, TRUE);

            // RichEdit occupies remaining space
            int editH = bottomY - 55;
            if (editH < 50) editH = 50;
            MoveWindow(g_hRichEdit, 15, 45, width - 30, editH, TRUE);
            return 0;
        }

        case WM_GETMINMAXINFO: {
            LPMINMAXINFO lpMMI = (LPMINMAXINFO)lParam;
            lpMMI->ptMinTrackSize.x = 580;
            lpMMI->ptMinTrackSize.y = 380;
            return 0;
        }

        case WM_CTLCOLORSTATIC: {
            HDC hdc = (HDC)wParam;
            HWND hCtl = (HWND)lParam;
            SetBkMode(hdc, TRANSPARENT);
            if (hCtl == g_hLblStatus) {
                SetTextColor(hdc, RGB(137, 180, 250)); // Soft Blue
            } else {
                SetTextColor(hdc, RGB(205, 214, 244)); // Text color
            }
            return (LRESULT)g_hBrushBg;
        }

        case WM_CTLCOLOREDIT: {
            HDC hdc = (HDC)wParam;
            SetBkMode(hdc, OPAQUE);
            SetBkColor(hdc, RGB(40, 42, 54));
            SetTextColor(hdc, RGB(248, 248, 242));
            return (LRESULT)g_hBrushInput;
        }

        case WM_COMMAND: {
            int id = LOWORD(wParam);
            if (id == ID_BTN_SEND) {
                // Send text from input
                int len = GetWindowTextLengthW(g_hEditInput);
                if (len > 0) {
                    std::vector<wchar_t> buf(len + 1);
                    GetWindowTextW(g_hEditInput, buf.data(), len + 1);
                    std::wstring text = buf.data();
                    text = Trim(text);
                    if (!text.empty()) {
                        SendLineToChild(text);
                        SetWindowTextW(g_hEditInput, L"");

                        // Add to history
                        g_cmdHistory.push_back(text);
                        g_historyIndex = (int)g_cmdHistory.size();

                        // If user sent a regular chat message, show it locally right away
                        if (!text.empty() && text[0] != L'/') {
                            std::wstring localEcho = g_wsUser + L": " + text + L"\n";
                            AppendFormattedLog(g_hRichEdit, localEcho);
                        }
                    }
                }
                SetFocus(g_hEditInput);
            }
            else if (id == ID_BTN_FILE) {
                // Open File Dialog to offer file
                wchar_t szFile[MAX_PATH] = {0};
                OPENFILENAMEW ofn = { sizeof(ofn) };
                ofn.hwndOwner   = hWnd;
                ofn.lpstrFile   = szFile;
                ofn.nMaxFile    = MAX_PATH;
                ofn.lpstrFilter = L"All Files (*.*)\0*.*\0";
                ofn.nFilterIndex= 1;
                ofn.Flags       = OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST;

                if (GetOpenFileNameW(&ofn)) {
                    std::wstring cmd = L"/send \"" + std::wstring(szFile) + L"\"";
                    SendLineToChild(cmd);
                    AppendFormattedLog(g_hRichEdit, L"[Local] Offering file: " + std::wstring(szFile) + L"\n");
                }
                SetFocus(g_hEditInput);
            }
            else if (id == ID_BTN_CONNECT) {
                // Read username & room from fields
                wchar_t uBuf[128] = {0};
                wchar_t rBuf[128] = {0};
                GetWindowTextW(g_hEditUser, uBuf, 128);
                GetWindowTextW(g_hEditRoom, rBuf, 128);

                g_wsUser = Trim(uBuf);
                g_wsRoom = Trim(rBuf);
                if (g_wsRoom.empty()) g_wsRoom = L"6767";

                if (g_wsUser.empty()) {
                    MessageBoxW(hWnd, L"Please enter a username before connecting.", L"Username Required", MB_ICONWARNING);
                    SetFocus(g_hEditUser);
                    return 0;
                }

                SaveConfigFile();

                if (g_bChildRunning.load()) {
                    TerminateChildProcess();
                }

                LaunchNodeProcess(g_wsUser, g_wsRoom);
                SetFocus(g_hEditInput);
            }
            else if (id == ID_BTN_USERS) {
                SendLineToChild(L"/list");
                SetFocus(g_hEditInput);
            }
            return 0;
        }

        // Close button: MINIMIZE TO TRAY instead of terminating!
        case WM_CLOSE: {
            ShowWindow(hWnd, SW_HIDE);
            if (!g_bBalloonShown) {
                ShowTrayBalloon(L"CLI Chat Running in Tray", L"CLI Chat is still active in the background. Double-click the tray icon to reopen.");
                g_bBalloonShown = true;
            }
            return 0;
        }

        // Tray Icon Events
        case WM_APP_TRAY: {
            if (lParam == WM_LBUTTONDBLCLK) {
                // Restore window
                ShowWindow(hWnd, SW_RESTORE);
                SetForegroundWindow(hWnd);
                SetFocus(g_hEditInput);
            }
            else if (lParam == WM_RBUTTONUP) {
                POINT pt;
                GetCursorPos(&pt);
                HMENU hMenu = CreatePopupMenu();
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_RESTORE, L"Show CLI Chat");
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_HIDE,    L"Hide to Tray");
                AppendMenuW(hMenu, MF_SEPARATOR, 0, NULL);
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_SENDFILE,L"Send File...");
                AppendMenuW(hMenu, MF_SEPARATOR, 0, NULL);
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_EXIT,    L"Exit CLI Chat");

                SetForegroundWindow(hWnd);
                int cmd = TrackPopupMenu(hMenu, TPM_RETURNCMD | TPM_NONOTIFY, pt.x, pt.y, 0, hWnd, NULL);
                DestroyMenu(hMenu);

                if (cmd == ID_TRAY_RESTORE) {
                    ShowWindow(hWnd, SW_RESTORE);
                    SetForegroundWindow(hWnd);
                    SetFocus(g_hEditInput);
                } else if (cmd == ID_TRAY_HIDE) {
                    ShowWindow(hWnd, SW_HIDE);
                } else if (cmd == ID_TRAY_SENDFILE) {
                    ShowWindow(hWnd, SW_RESTORE);
                    SetForegroundWindow(hWnd);
                    SendMessageW(hWnd, WM_COMMAND, MAKEWPARAM(ID_BTN_FILE, 0), 0);
                } else if (cmd == ID_TRAY_EXIT) {
                    g_bExiting = true;
                    DestroyWindow(hWnd);
                }
            }
            return 0;
        }

        // Incoming Log Line from Node background thread
        case WM_APP_ADD_LOG: {
            std::wstring* pStr = (std::wstring*)lParam;
            if (pStr) {
                AppendFormattedLog(g_hRichEdit, *pStr);

                // If window is minimized/hidden, notify on chat messages / whispers
                if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) {
                    if (pStr->find(L": ") != std::wstring::npos &&
                        pStr->find(L"[System]") == std::wstring::npos) {
                        ShowTrayBalloon(L"CLI Chat", *pStr);
                    } else if (pStr->find(L"[PM from") != std::wstring::npos) {
                        ShowTrayBalloon(L"Private Message", *pStr);
                    } else if (pStr->find(L"is sending") != std::wstring::npos) {
                        ShowTrayBalloon(L"File Transfer", *pStr);
                    }
                }

                // Status updates
                if (pStr->find(L"Connected to api.cfat.site") != std::wstring::npos) {
                    SetWindowTextW(g_hLblStatus, L"Connected to api.cfat.site");
                    SetWindowTextW(g_hBtnConnect, L"Reconnect");
                    std::wstring title = L"CLI Chat - Room: " + g_wsRoom + L" | User: " + g_wsUser;
                    SetWindowTextW(hWnd, title.c_str());
                    wcscpy_s(g_nid.szTip, title.substr(0, 127).c_str());
                    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
                } else if (pStr->find(L"Disconnected") != std::wstring::npos) {
                    SetWindowTextW(g_hLblStatus, L"Disconnected");
                }

                delete pStr;
            }
            return 0;
        }

        case WM_APP_CHILD_EXIT: {
            SetWindowTextW(g_hLblStatus, L"Process stopped");
            SetWindowTextW(g_hBtnConnect, L"Connect");
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

/* ─── Subclass Proc for Input Box (Enter to Send, Up/Down for History) ───── */
LRESULT CALLBACK InputSubclassProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_KEYDOWN) {
        if (wParam == VK_RETURN) {
            SendMessageW(g_hWndMain, WM_COMMAND, MAKEWPARAM(ID_BTN_SEND, 0), 0);
            return 0; // Prevent beep
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

/* ─── RichEdit Formatted Logging ─────────────────────────────────────────── */
void AppendFormattedLog(HWND hEdit, const std::wstring& line) {
    if (!hEdit || line.empty()) return;

    // Move selection to the very end
    CHARRANGE cr;
    cr.cpMin = -1;
    cr.cpMax = -1;
    SendMessageW(hEdit, EM_EXSETSEL, 0, (LPARAM)&cr);

    // Determine color based on content
    COLORREF color = RGB(220, 224, 232); // Default text color (#dce0e8)
    bool bold = false;

    if (line.find(L"[System]") != std::wstring::npos) {
        color = RGB(116, 199, 236); // Cyan (#74c7ec)
        bold  = true;
    } else if (line.find(L"[Error]") != std::wstring::npos) {
        color = RGB(243, 139, 168); // Red (#f38ba8)
        bold  = true;
    } else if (line.find(L"[PM from") != std::wstring::npos || line.find(L"[Whisper") != std::wstring::npos) {
        color = RGB(203, 166, 247); // Mauve / Purple (#cba6f7)
        bold  = true;
    } else if (line.find(L"is sending") != std::wstring::npos || line.find(L"Offering file") != std::wstring::npos || line.find(L"✔ Download complete") != std::wstring::npos) {
        color = RGB(249, 226, 175); // Gold / Yellow (#f9e2af)
        bold  = true;
    } else if (line.find(L"Online in") != std::wstring::npos) {
        color = RGB(166, 227, 161); // Green (#a6e3a1)
        bold  = true;
    } else if (line.find(L": ") != std::wstring::npos) {
        color = RGB(180, 190, 254); // Lavender (#b4befe)
    }

    CHARFORMAT2W cf;
    memset(&cf, 0, sizeof(cf));
    cf.cbSize      = sizeof(cf);
    cf.dwMask      = CFM_COLOR | CFM_BOLD;
    cf.crTextColor = color;
    cf.dwEffects   = bold ? CFE_BOLD : 0;

    SendMessageW(hEdit, EM_SETCHARFORMAT, SCF_SELECTION, (LPARAM)&cf);

    // Replace selection with text
    SendMessageW(hEdit, EM_REPLACESEL, FALSE, (LPARAM)line.c_str());

    // Scroll to bottom
    SendMessageW(hEdit, WM_VSCROLL, SB_BOTTOM, 0);
}

/* ─── Node Process Management ────────────────────────────────────────────── */
void LaunchNodeProcess(const std::wstring& user, const std::wstring& room) {
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

    // Command line: node.exe dev.js --user <user> --room <room> -s
    std::wstring cmd = L"node.exe dev.js --user \"" + user + L"\" --room \"" + room + L"\" -s";
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
        AppendFormattedLog(g_hRichEdit, L"[Error] Failed to launch Node.js process. Make sure Node.js is installed in PATH.\n");
        return;
    }

    g_hChildProcess = pi.hProcess;
    CloseHandle(pi.hThread);
    g_bChildRunning.store(true);

    SetWindowTextW(g_hLblStatus, L"Connecting...");

    // Spawn Background Reader Thread
    g_pReaderThread = new std::thread([]() {
        HANDLE hRead = g_hChildStdoutRd;
        char buffer[2048];
        DWORD bytesRead = 0;
        std::string lineAccumulator;

        while (ReadFile(hRead, buffer, sizeof(buffer) - 1, &bytesRead, NULL) && bytesRead > 0) {
            buffer[bytesRead] = '\0';
            lineAccumulator.append(buffer, bytesRead);

            size_t pos = 0;
            while ((pos = lineAccumulator.find('\n')) != std::string::npos) {
                std::string rawLine = lineAccumulator.substr(0, pos);
                lineAccumulator.erase(0, pos + 1);

                if (!rawLine.empty() && rawLine.back() == '\r') {
                    rawLine.pop_back();
                }

                std::wstring cleanLine = StripAnsi(rawLine);
                std::wstring trimmed = Trim(cleanLine);

                // Filter out bare interactive readline terminal prompts (e.g. "username:" or "username: username:")
                if (!g_wsUser.empty()) {
                    std::wstring promptPattern = g_wsUser + L":";
                    bool isPromptOnly = true;
                    std::wstring check = trimmed;
                    while (!check.empty()) {
                        if (check.rfind(promptPattern, 0) == 0) {
                            check = Trim(check.substr(promptPattern.length()));
                        } else {
                            isPromptOnly = false;
                            break;
                        }
                    }
                    if (isPromptOnly && !trimmed.empty()) {
                        continue;
                    }
                }

                if (!cleanLine.empty()) {
                    cleanLine += L"\n";
                    std::wstring* pStr = new std::wstring(cleanLine);
                    PostMessageW(g_hWndMain, WM_APP_ADD_LOG, 0, (LPARAM)pStr);
                }
            }
        }

        g_bChildRunning.store(false);
        PostMessageW(g_hWndMain, WM_APP_CHILD_EXIT, 0, 0);
    });
}

void TerminateChildProcess() {
    g_bChildRunning.store(false);

    if (g_hChildStdinWr) {
        // Send /quit to allow clean socket closure
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

void SendLineToChild(const std::wstring& text) {
    if (!g_hChildStdinWr || !g_bChildRunning.load()) {
        AppendFormattedLog(g_hRichEdit, L"[Error] Chat client is not connected. Click 'Connect' first.\n");
        return;
    }

    // Convert wchar to UTF-8
    int needed = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), (int)text.length(), NULL, 0, NULL, NULL);
    if (needed <= 0) return;

    std::string utf8(needed, 0);
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), (int)text.length(), &utf8[0], needed, NULL, NULL);
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

/* ─── Config Persistence (gui_config.ini) ────────────────────────────────── */
void LoadConfigFile() {
    wchar_t szUser[128] = {0};
    wchar_t szRoom[128] = {0};
    GetPrivateProfileStringW(L"Settings", L"Username", L"", szUser, 128, L".\\gui_config.ini");
    GetPrivateProfileStringW(L"Settings", L"Room", L"6767", szRoom, 128, L".\\gui_config.ini");
    g_wsUser = szUser;
    g_wsRoom = szRoom;
}

void SaveConfigFile() {
    WritePrivateProfileStringW(L"Settings", L"Username", g_wsUser.c_str(), L".\\gui_config.ini");
    WritePrivateProfileStringW(L"Settings", L"Room", g_wsRoom.c_str(), L".\\gui_config.ini");
}

/* ─── Utility Helpers ────────────────────────────────────────────────────── */
std::wstring Trim(const std::wstring& s) {
    size_t first = s.find_first_not_of(L" \t\r\n");
    if (first == std::wstring::npos) return L"";
    size_t last = s.find_last_not_of(L" \t\r\n");
    return s.substr(first, (last - first + 1));
}

std::wstring StripAnsi(const std::string& input) {
    std::string clean;
    bool inEscape = false;
    for (size_t i = 0; i < input.size(); ++i) {
        if (input[i] == '\x1B') {
            inEscape = true;
        } else if (inEscape) {
            if ((input[i] >= 'A' && input[i] <= 'Z') || (input[i] >= 'a' && input[i] <= 'z')) {
                inEscape = false;
            }
        } else {
            clean += input[i];
        }
    }

    if (clean.empty()) return L"";

    int needed = MultiByteToWideChar(CP_UTF8, 0, clean.c_str(), (int)clean.length(), NULL, 0);
    if (needed <= 0) return L"";

    std::wstring result(needed, 0);
    MultiByteToWideChar(CP_UTF8, 0, clean.c_str(), (int)clean.length(), &result[0], needed);
    return result;
}
