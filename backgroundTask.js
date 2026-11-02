import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

export const BACKGROUND_CALL_SYNC_TASK = 'TRIVEN_BACKGROUND_CALL_SYNC';
const API_BASE_URL = 'https://xluxtriven.de/api/v1';

let CallLog = null;
try {
  CallLog = require('react-native-call-log');
  if (CallLog?.default) CallLog = CallLog.default;
} catch (e) {
  console.log('CallLog native module not found in background context');
}

// Define the 20-minute background task
TaskManager.defineTask(BACKGROUND_CALL_SYNC_TASK, async () => {
  try {
    const token = await AsyncStorage.getItem('token');
    if (!token) {
      console.log('[BackgroundFetch] No active login token found');
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    if (!CallLog || typeof CallLog.load !== 'function') {
      console.log('[BackgroundFetch] CallLog native module is unavailable');
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }

    const logs = await CallLog.load(50);
    if (!logs || logs.length === 0) {
      console.log('[BackgroundFetch] No call logs found to sync');
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    const payload = logs.map((log) => {
      let type = 'outgoing';
      if (log.type === 'INCOMING') type = 'incoming';
      if (log.type === 'MISSED') type = 'missed';
      if (log.type === 'REJECTED') type = 'rejected';

      return {
        phone: log.phoneNumber,
        callType: type,
        duration: parseInt(log.duration || 0, 10),
        timestamp: new Date(parseInt(log.timestamp, 10)).toISOString(),
      };
    });

    await axios.post(
      `${API_BASE_URL}/call-logs/sync`,
      { logs: payload },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      }
    );

    const now = new Date().toISOString();
    await AsyncStorage.setItem('lastSyncTime', now);
    console.log('[BackgroundFetch] Successfully synced call logs at', now);

    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (err) {
    console.log('[BackgroundFetch] Sync error:', err.message);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// Helper to register the background task with a 20-minute interval
export const registerBackgroundSync = async () => {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_CALL_SYNC_TASK);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_CALL_SYNC_TASK, {
        minimumInterval: 20 * 60, // 20 minutes in seconds (1200s)
        stopOnTerminate: false, // Continue running in background after app is closed
        startOnBoot: true, // Start task automatically when phone boots
      });
      console.log('[BackgroundFetch] 20-minute auto-sync task registered successfully');
    } else {
      console.log('[BackgroundFetch] 20-minute auto-sync task already registered');
    }
  } catch (error) {
    console.log('[BackgroundFetch] Registration error:', error.message);
  }
};

