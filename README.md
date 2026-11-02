# Triven Telecalling Tracker Android APK

A background telecalling tracking application for Triven Ayurveda telecallers that silently syncs phone call records, calculates customer talk-time, updates CNP counts, and flags duplicate dials with the Triven CRM.

## Prerequisites to Build APK
- Node.js 18+
- JDK 17
- Android Studio / Android SDK (API 34)

## Quick Build Instructions

```bash
# 1. Install dependencies
cd MobileApp
npm install

# 2. Build Release APK (Private distribution)
cd android
./gradlew assembleRelease
```

The compiled APK will be located at:
`android/app/build/outputs/apk/release/app-release.apk`

Copy this file to:
`Frontend/public/downloads/triven-calling-tracker.apk`

## Permissions Used
- `READ_CALL_LOG`: To extract call duration, timestamp, and customer phone number.
- `READ_PHONE_STATE`: To detect when call disconnects (IDLE state).
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`: To ensure Android doesn't kill the background sync service.

