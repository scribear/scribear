# ScribeAR Room Webapp Specification

## Codebase Overview

ScribeAR is a live transcription service designed for classroom deployment.

### Current Components

- **Transcription Service** – Accepts WebSocket connections; receives audio and sends back text transcriptions.
- **Node-Server** – Middleman bridge between client apps and the transcription service / session manager.
- **Session-Manager** – Bookkeeper for sessions that handles scheduling, starting, etc.

### Core Concepts

- **Room** – Where ScribeAR is deployed. Currently, the session manager room and device are the same thing.
- **Session** – Each room/device can have up to 1 current session and many sessions scheduled for the future.

---

## Desired Added Component: Room Webapp

A room-level control and viewing webapp that drives two displays:

1. **Touchscreen** – Host-level controls and information (upcoming sessions, mute mic, font size for big screen, etc.)
2. **Large Participants Screen** – Read-only; displays transcriptions for the specific room and session.

---

## Component-by-Component Details

### Touchscreen – Activation

- The unified webapp is treated as one device. The current session-manager schema allows 1 device per room.
- Using the session manager activation endpoint, a device can be registered to a room.
- When a device is activated through the endpoint, an **activation code** is created.
- The touchscreen view should have an **initial activation page** where the code can be entered and sent to the session manager activation endpoint to receive an authentication cookie.
- Once that cookie is received, the entire webapp is registered to a room and **both screens are unlocked**.
- Once authenticated, the state should be stored in the browser and **authentication should persist**.
- On the server side, the needed info to authenticate the cookie is already stored in the DB.

---

### Touchscreen – Home Display

Once the webapp is authenticated, the home display should populate the touchscreen with:

- **Upcoming sessions** for that room.
- If a session is **currently ongoing**:
  - Indicator that a session is in progress
  - When it ends
  - A button to **pause the mic**
  - Settings for the larger screen:
    - Font size for transcriptions
    - Whether to display the session join code
  - Settings changed on the touchscreen should take effect **in real time**.
- **Room name** displayed somewhere visible.
- An **indicator for the connection to the server**.

---

### Large Display

| State | Behavior |
|---|---|
| Not activated | Show a message saying the device needs to be activated via the touchscreen |
| Activated, no session | Show a list of upcoming sessions |
| Activated, session ongoing | Display live transcriptions (and join code if enabled); show a clear indicator that live transcription is active |

- Room name should be visible.
- Join/QR code (when enabled) should be large enough for cameras to capture but small enough to maximize transcription display area.

---

## Implementation-Level Details

### Authentication

- Unactivated webapps must be fully locked down on both displays.
- Authentication is a **one-time thing** per device/browser.
- Both **on-screen keyboard** (alphanumeric) and **physical keyboard** should work for entering the activation code.

---

### Touchscreen: Home Display

- A new endpoint may need to be added to the session manager to **get all sessions for a specific room**.
- When a session starts, the screen should **update automatically and quickly**.
- Upcoming sessions should show sessions for that day, updating relatively quickly.
- A **mute button** is required. Since the microphone may be independent of the device, muting must happen at the **node server level**.

---

### Large Display

- When activated and a session is running, display **live transcriptions** (similar to the existing client-webapp).
- If the **"display join code"** feature is enabled on the touchscreen, show the join code/QR code for the currently running session on the side.

---

### Communication Between Screens

Settings changed on the touchscreen must reflect on the large display **instantly**. One possible option is:

- **Broadcast Channel API**  – allows same-origin tabs/windows to communicate without a server round-trip.

---

## Overall Guidelines

### Respect the Current Codebase

- Integrate this app into the existing codebase as much as possible.
- Minimize changes to existing code, but correctness takes priority over minimalism.
- All changes to the existing codebase must be **documented in a markdown file**.

### Consistent Design

- Follow the conventions of existing webapps where reasonable.
- Ensure all added endpoints respect **security best practices**.

### Known Bugs

- There may be bugs in the session manager (especially around scheduling).
- If fixing bugs is necessary for proper functionality or testing, fixes are allowed but must be **documented in a markdown file**.