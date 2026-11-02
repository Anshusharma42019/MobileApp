# 🚀 5-Minute Free Cloud APK Build Guide (No Android Studio Needed)

Is guide se aap bina Java ya Android Studio ke direct **Expo Cloud** se real `.apk` file generate kar sakte hain.

---

### Step 1: Terminal / Command Prompt Kholein
Apne computer ke terminal par `MobileApp` folder mein jayein:

```bash
cd G:\MadeByXluxTech\MobileApp
```

---

### Step 2: EAS CLI se Login Karein
Agar aapka free Expo account nahi hai, toh [expo.dev](https://expo.dev) par jakar 30 seconds mein free account bana lijiye, phir terminal par run karein:

```bash
npx eas-cli login
```
(Apna email aur password enter karein).

---

### Step 3: APK Build Command Run Karein

Bas yeh ek command run karni hai:

```bash
npx eas-cli build -p android --profile preview
```

### Kya hoga?
1. EAS aapse poochega: *"Generate a new Android Keystore?"* ➔ **Yes (Press Enter)** kar dijiye.
2. Expo ka cloud computer aapke pure code ko automatically compile karega (isme 3-5 minute lagte hain).
3. Build complete hote hi terminal par **Direct Download Link** aa jayega (jaise: `https://expo.dev/artifacts/eas/.../app-release.apk`) aur ek **QR Code** bhi dikhega.

---

### Step 4: File ko CRM mein Rakhein
Download ki hui `.apk` file ko copy karke is folder mein paste kar dijiye:
```text
G:\MadeByXluxTech\Frontend\public\downloads\triven-calling-tracker.apk
```

Ab aapke web CRM se koi bhi employee download karega, toh 100% real working APK download hogi aur bina kisi parse error ke install ho jayegi!

