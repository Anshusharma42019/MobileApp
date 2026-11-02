import React, { useState, useEffect, useRef } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  FlatList,
  PermissionsAndroid,
  Alert,
  ActivityIndicator,
  StatusBar,
  AppState,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { registerRootComponent } from 'expo';
import { registerBackgroundSync } from './backgroundTask';

let CallLog = null;
try {
  CallLog = require('react-native-call-log');
  if (CallLog?.default) CallLog = CallLog.default;
} catch (e) {
  console.log('CallLog module fallback initialized');
}

const API_BASE_URL = 'https://xluxtriven.de/api/v1';

export default function App() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [callLogs, setCallLogs] = useState([]);
  const [stats, setStats] = useState({ total: 0, connected: 0, cnp: 0, talkTime: 0 });
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    checkSavedSession();
  }, []);

  useEffect(() => {
    if (token) {
      requestCallPermissions();
      loadLocalCallLogs();
      registerBackgroundSync(); // Registers 20-min WorkManager background task

      // Initial sync on startup
      syncCallsWithServer();

      // Periodic Auto-Sync every 20 minutes (20 * 60 * 1000 ms)
      const interval = setInterval(() => {
        syncCallsWithServer();
      }, 20 * 60 * 1000);

      // Listen for app coming to foreground (e.g. employee just finished phone call)
      const subscription = AppState.addEventListener('change', (nextAppState) => {
        if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
          syncCallsWithServer();
        }
        appState.current = nextAppState;
      });

      return () => {
        clearInterval(interval);
        subscription.remove();
      };
    }
  }, [token]);

  const checkSavedSession = async () => {
    try {
      const savedUser = await AsyncStorage.getItem('user');
      const savedToken = await AsyncStorage.getItem('token');
      const savedSync = await AsyncStorage.getItem('lastSyncTime');
      if (savedSync) setLastSyncTime(savedSync);
      if (savedUser && savedToken) {
        setUser(JSON.parse(savedUser));
        setToken(savedToken);
      }
    } catch (e) {
      console.log('Error reading storage', e);
    }
  };

  const requestCallPermissions = async () => {
    try {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
        PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
      ]);
      if (
        granted['android.permission.READ_CALL_LOG'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.READ_PHONE_STATE'] === PermissionsAndroid.RESULTS.GRANTED
      ) {
        console.log('Call permissions active');
      } else {
        Alert.alert('Permission Required', 'Call log permission is required to track calls');
      }
    } catch (err) {
      console.warn(err);
    }
  };

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Required', 'Please enter email or phone and password');
      return;
    }
    setLoading(true);
    try {
      const cleanInput = email.trim();
      const isPhone = /^\+?[\d\s-]{7,15}$/.test(cleanInput);
      const payload = {
        password,
        ...(isPhone ? { phone: cleanInput } : { email: cleanInput }),
      };
      const res = await axios.post(`${API_BASE_URL}/auth/login`, payload);
      const { user: userData, tokens } = res.data.data;
      await AsyncStorage.setItem('user', JSON.stringify(userData));
      await AsyncStorage.setItem('token', tokens.access.token);
      setUser(userData);
      setToken(tokens.access.token);
    } catch (err) {
      Alert.alert('Login Failed', err.response?.data?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await AsyncStorage.clear();
    setUser(null);
    setToken(null);
  };

  const loadLocalCallLogs = async () => {
    try {
      if (!CallLog || typeof CallLog.load !== 'function') {
        return;
      }
      const logs = await CallLog.load(50);
      setCallLogs(logs);

      let total = logs.length;
      let connected = 0;
      let cnp = 0;
      let talkTime = 0;

      logs.forEach((log) => {
        const dur = parseInt(log.duration || 0, 10);
        if (log.type === 'OUTGOING') {
          if (dur > 0) {
            connected++;
            talkTime += dur;
          } else {
            cnp++;
          }
        }
      });

      setStats({ total, connected, cnp, talkTime });
    } catch (e) {
      console.log('Error loading logs', e);
    }
  };

  const syncCallsWithServer = async () => {
    if (!token) return;
    if (!CallLog || typeof CallLog.load !== 'function') return;
    setSyncing(true);
    try {
      const logs = await CallLog.load(30);
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
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setLastSyncTime(now);
      await AsyncStorage.setItem('lastSyncTime', now);
      loadLocalCallLogs();
    } catch (e) {
      console.log('Sync error:', e.message);
    } finally {
      setSyncing(false);
    }
  };

  const fmtDuration = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };

  if (!user) {
    return (
      <SafeAreaView style={styles.loginContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#071407" />
        <View style={styles.loginBox}>
          <Text style={styles.brandTitle}>TRIVEN AYURVEDA</Text>
          <Text style={styles.brandSubtitle}>Staff Telecalling Tracker</Text>

          <TextInput
            placeholder="CRM Email or Phone"
            placeholderTextColor="#888"
            value={email}
            onChangeText={setEmail}
            style={styles.input}
            autoCapitalize="none"
          />
          <TextInput
            placeholder="Password"
            placeholderTextColor="#888"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            style={styles.input}
          />

          <TouchableOpacity style={styles.loginBtn} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.loginBtnText}>LOGIN TO CRM</Text>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#071407" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.userName}>{user.name}</Text>
          <Text style={styles.userRole}>
            {user.role} • {user.departments?.join(', ') || 'Sales'}
          </Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutBtnText}>Logout</Text>
        </TouchableOpacity>
      </View>

      {/* Live Badge */}
      <View style={styles.statusBadge}>
        <View style={styles.pulseDot} />
        <View style={{ flex: 1 }}>
          <Text style={styles.statusText}>Auto-Sync: Active (Every 20 Mins & On Call End)</Text>
          <Text style={styles.statusSubText}>
            Last Synced: {lastSyncTime ? `${lastSyncTime}` : 'Connecting...'}
          </Text>
        </View>
      </View>

      {/* Stats Cards */}
      <View style={styles.statsGrid}>
        <View style={[styles.statCard, { borderLeftColor: '#3b82f6' }]}>
          <Text style={styles.statLabel}>Total Calls</Text>
          <Text style={styles.statVal}>{stats.total}</Text>
        </View>
        <View style={[styles.statCard, { borderLeftColor: '#10b981' }]}>
          <Text style={styles.statLabel}>Connected</Text>
          <Text style={styles.statVal}>{stats.connected}</Text>
        </View>
        <View style={[styles.statCard, { borderLeftColor: '#f59e0b' }]}>
          <Text style={styles.statLabel}>CNP (Unanswered)</Text>
          <Text style={styles.statVal}>{stats.cnp}</Text>
        </View>
        <View style={[styles.statCard, { borderLeftColor: '#8b5cf6' }]}>
          <Text style={styles.statLabel}>Talk-Time</Text>
          <Text style={styles.statVal}>{fmtDuration(stats.talkTime)}</Text>
        </View>
      </View>

      {/* Sync Button */}
      <TouchableOpacity style={styles.syncBtn} onPress={syncCallsWithServer} disabled={syncing}>
        {syncing ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.syncBtnText}>🔄 SYNC WITH CRM NOW</Text>
        )}
      </TouchableOpacity>

      {/* Recent Calls Feed */}
      <View style={styles.feedHeader}>
        <Text style={styles.feedTitle}>Recent Calls Monitored</Text>
        <Text style={styles.feedSubtitle}>{callLogs.length} calls logged</Text>
      </View>

      <FlatList
        data={callLogs}
        keyExtractor={(item, index) => String(item.timestamp || index)}
        renderItem={({ item }) => {
          const isConnected = parseInt(item.duration || 0, 10) > 0;
          return (
            <View style={styles.callRow}>
              <View style={styles.callDetails}>
                <Text style={styles.callPhone}>{item.phoneNumber}</Text>
                <Text style={styles.callTime}>
                  {item.type} • {new Date(parseInt(item.timestamp, 10)).toLocaleTimeString()}
                </Text>
              </View>
              <View style={[styles.durationBadge, { backgroundColor: isConnected ? '#064e3b' : '#451a03' }]}>
                <Text style={[styles.durationText, { color: isConnected ? '#34d399' : '#fbbf24' }]}>
                  {isConnected ? fmtDuration(parseInt(item.duration, 10)) : '0s (Not Picked)'}
                </Text>
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loginContainer: { flex: 1, backgroundColor: '#071407', justifyContent: 'center', padding: 24 },
  loginBox: { backgroundColor: '#0f240f', padding: 24, borderRadius: 16, borderWidth: 1, borderColor: '#1f481f' },
  brandTitle: { color: '#4ade80', fontSize: 22, fontWeight: 'bold', textAlign: 'center', letterSpacing: 1 },
  brandSubtitle: { color: '#9ca3af', fontSize: 13, textAlign: 'center', marginBottom: 24 },
  input: { backgroundColor: '#071407', color: '#fff', padding: 14, borderRadius: 10, marginBottom: 14, borderWidth: 1, borderColor: '#1f481f' },
  loginBtn: { backgroundColor: '#16a34a', padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 8 },
  loginBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 14, letterSpacing: 1 },

  container: { flex: 1, backgroundColor: '#071407', padding: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  userName: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  userRole: { color: '#4ade80', fontSize: 12 },
  logoutBtn: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#1f2937', borderRadius: 8 },
  logoutBtnText: { color: '#ef4444', fontSize: 12, fontWeight: 'bold' },

  statusBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#064e3b', padding: 10, borderRadius: 10, marginBottom: 16 },
  pulseDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#34d399', marginRight: 10 },
  statusText: { color: '#34d399', fontSize: 12, fontWeight: '700' },
  statusSubText: { color: '#a7f3d0', fontSize: 11, marginTop: 2 },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 },
  statCard: { width: '48%', backgroundColor: '#0f240f', padding: 12, borderRadius: 10, marginBottom: 10, borderLeftWidth: 4 },
  statLabel: { color: '#9ca3af', fontSize: 11, marginBottom: 4 },
  statVal: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  syncBtn: { backgroundColor: '#15803d', padding: 14, borderRadius: 10, alignItems: 'center', marginBottom: 16 },
  syncBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },

  feedHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  feedTitle: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  feedSubtitle: { color: '#6b7280', fontSize: 11 },

  callRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0d1f0d', padding: 12, borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: '#1f481f' },
  callDetails: { flex: 1 },
  callPhone: { color: '#fff', fontSize: 14, fontWeight: '600' },
  callTime: { color: '#9ca3af', fontSize: 11, marginTop: 2 },
  durationBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  durationText: { fontSize: 11, fontWeight: 'bold' },
});

registerRootComponent(App);

