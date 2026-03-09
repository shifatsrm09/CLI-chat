# CLI Chat

A **terminal-based real-time chat and file sharing tool** designed for small developer groups and university lab environments.

The application runs entirely in the **command line** and allows users to exchange messages and files (~100mb) instantly.

The server is hosted online, so users only need the client executable to start chatting.

---


## Windows Usage

1. Download **`client.exe`** from the Releases page.
2. Place it in your working directory.
3. Open **Command Prompt** or **PowerShell** in that folder.
4. Run:

```
.\client.exe
```

5. Enter your username when prompted.

Example:

```
Enter your username: Alice
```

Once connected, you can begin chatting.

---

## Linux Usage

1. Download **`client-linux`** from the Releases page.
2. Open a terminal in the download folder.
3. Make the file executable:

```
chmod +x client-linux
```

4. Run the client:

```
./client-linux
```

5. Enter your username when prompted.

---

## Chatting

This version automatically creates a room 8888 and 5 people can join it for prompt experience.

Simply type a message and press **Enter**.

Example:

```
Alice: Hello everyone
```

Other users connected to the server will instantly receive the message.

---

## Sending Files

To send a file, use the command:

```
/send <filename>
```

Example:

```
/send test.txt
```

The recipient will see a prompt asking whether to accept the file.

If accepted, the file will be saved in the **current working directory**.

---

## Limits

* Intended for **small file transfers**
* Files are **not stored on the server** (they are relayed directly between users)

---

## License

This project is intended for educational and experimental purposes.
