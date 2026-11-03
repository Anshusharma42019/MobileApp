import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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
  Linking,
  RefreshControl,
  ScrollView,
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
  // Auth state
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Sync & Loading states
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [syncBanner, setSyncBanner] = useState(null);

  // Filter states
  const [timeFilter, setTimeFilter] = useState('today'); // 'today' | 'yesterday' | 'week' | 'month' | 'all'
  const [categoryFilter, setCategoryFilter] = useState('all'); // 'all' | 'connected' | 'cnp' | 'missed'
  const [searchQuery, setSearchQuery] = useState('');

  // Data states
  const [crmLogs, setCrmLogs] = useState([]);
  const [localLogs, setLocalLogs] = useState([]);
  const [stats, setStats] = useState({
    dialedCalls: 0,
    connectedCalls: 0,
    cnpCalls: 0,
    missedCalls: 0,
    pendingMissedCalls: 0,
    resolvedMissedCalls: 0,
    totalTalkTime: 0,
    avgDuration: 0,
  });

  const appState = useRef(AppState.currentState);

  // Check saved session on boot
  useEffect(() => {
    checkSavedSession();
  }, []);

  // When token is ready: request permissions, sync, register background worker
  useEffect(() => {
    if (token && user) {
      requestCallPermissions();
      registerBackgroundSync(); // Registers 20-min WorkManager background task

      // Initial sync & fetch
      syncAndRefreshAll();

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
  }, [token, user?._id]);

  // When time filter changes, re-fetch server stats & logs
  useEffect(() => {
    if (token && user) {
      fetchServerData();
    }
  }, [timeFilter]);

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
        Alert.alert(
          'Permissions Required',
          'Triven Calling Tracker requires Call Log permissions to automatically track staff calls for CRM.'
        );
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
    setLoginLoading(true);
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
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to log out of Triven Calling Tracker?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          await AsyncStorage.clear();
          setUser(null);
          setToken(null);
          setCrmLogs([]);
          setLocalLogs([]);
        },
      },
    ]);
  };

  // Helper: compute ISO date range based on selected time filter
  const computeDateRange = (filter) => {
    const now = new Date();
    let startDate = null;
    let endDate = null;

    if (filter === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
    } else if (filter === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      startDate = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0, 0).toISOString();
      endDate = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999).toISOString();
    } else if (filter === 'week') {
      const w = new Date(now);
      w.setDate(w.getDate() - 7);
      w.setHours(0, 0, 0, 0);
      startDate = w.toISOString();
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
    } else if (filter === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
    } else if (filter === 'all') {
      startDate = null;
      endDate = null;
    }

    return { startDate, endDate };
  };

  // Fetch dynamic stats & matched call logs from CRM Server
  const fetchServerData = async () => {
    if (!token || !user) return;
    try {
      const { startDate, endDate } = computeDateRange(timeFilter);

      // 1. Fetch exact aggregated stats for this employee
      const statsReq = axios.get(`${API_BASE_URL}/call-logs/stats`, {
        params: {
          staffId: user._id,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        },
        headers: { Authorization: `Bearer ${token}` },
      });

      // 2. Fetch call records with matched customer names
      const logsReq = axios.get(`${API_BASE_URL}/call-logs`, {
        params: {
          staffId: user._id,
          limit: 100,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        },
        headers: { Authorization: `Bearer ${token}` },
      });

      const [statsRes, logsRes] = await Promise.all([statsReq, logsReq]);

      if (statsRes.data?.data?.summary) {
        const s = statsRes.data.data.summary;
        const dialed = s.dialedCalls !== undefined ? s.dialedCalls : ((s.connectedCalls || 0) + (s.cnpCalls || 0));
        const avg = s.connectedCalls > 0 ? Math.round((s.totalTalkTime || 0) / s.connectedCalls) : 0;
        setStats({
          dialedCalls: dialed,
          totalDialAttempts: s.totalDialAttempts || dialed,
          connectedCalls: s.connectedCalls || 0,
          cnpCalls: s.cnpCalls || 0,
          totalCnpAttempts: s.totalCnpAttempts || s.cnpCalls || 0,
          missedCalls: s.missedCalls || 0,
          pendingMissedCalls: s.pendingMissedCalls || 0,
          resolvedMissedCalls: s.resolvedMissedCalls || 0,
          totalTalkTime: s.totalTalkTime || 0,
          avgDuration: avg,
        });
      }

      if (logsRes.data?.data?.logs) {
        setCrmLogs(logsRes.data.data.logs);
      }
    } catch (err) {
      console.log('[MobileApp] Error fetching server data:', err.message);
    }
  };

  // Read local phone call log (fallback and sync source)
  const readLocalPhoneLogs = async () => {
    try {
      if (!CallLog || typeof CallLog.load !== 'function') return [];
      const logs = await CallLog.load(100);
      setLocalLogs(logs || []);
      return logs || [];
    } catch (e) {
      console.log('Error reading local calls', e);
      return [];
    }
  };

  // Sync phone calls with CRM Server
  const syncCallsWithServer = async () => {
    if (!token) return;
    setSyncing(true);
    try {
      const logs = await readLocalPhoneLogs();
      if (!logs || logs.length === 0) {
        setSyncing(false);
        return;
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

      const res = await axios.post(
        `${API_BASE_URL}/call-logs/sync`,
        { logs: payload },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setLastSyncTime(now);
      await AsyncStorage.setItem('lastSyncTime', now);

      const synced = res.data?.data?.synced || 0;
      setSyncBanner(`✓ Synced ${synced} calls with CRM at ${now}`);
      setTimeout(() => setSyncBanner(null), 4000);

      // Immediately refresh dynamic CRM stats & call feed
      await fetchServerData();
    } catch (e) {
      console.log('Sync error:', e.message);
      setSyncBanner(`⚠️ Sync error: ${e.message}`);
      setTimeout(() => setSyncBanner(null), 4000);
    } finally {
      setSyncing(false);
    }
  };

  // Pull to refresh
  const syncAndRefreshAll = async () => {
    setRefreshing(true);
    await syncCallsWithServer();
    await fetchServerData();
    setRefreshing(false);
  };

  // Call duration formatter
  const fmtDuration = (sec = 0) => {
    if (!sec || sec <= 0) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  // Redial number via native Android dialer
  const handleDial = (phoneNumber) => {
    if (!phoneNumber) return;
    const clean = String(phoneNumber).replace(/\s+/g, '');
    Linking.openURL(`tel:${clean}`).catch((err) => {
      Alert.alert('Unable to Dial', 'Could not open phone dialer: ' + err.message);
    });
  };

  // Filtered & grouped call feed
  const displayedCalls = useMemo(() => {
    // Prefer server records (which include matched CRM customer names)
    // Fall back to local phone calls if server list is empty
    let list = crmLogs.length > 0 ? [...crmLogs] : localLogs.map((l) => ({
      _id: l.timestamp,
      phoneNumber: l.phoneNumber,
      leadName: 'Customer',
      callType: l.type === 'OUTGOING' ? 'outgoing' : l.type === 'INCOMING' ? 'incoming' : 'missed',
      duration: parseInt(l.duration || 0, 10),
      timestamp: new Date(parseInt(l.timestamp, 10)).toISOString(),
      status: l.type === 'MISSED' ? 'missed_pending' : 'processed',
    }));

    // 1. Category Filter
    if (categoryFilter === 'connected') {
      list = list.filter((c) => c.callType === 'outgoing' && c.duration > 0);
    } else if (categoryFilter === 'cnp') {
      list = list.filter((c) => c.callType === 'outgoing' && c.duration === 0);
    } else if (categoryFilter === 'missed') {
      list = list.filter((c) => c.callType === 'missed');
    }

    // 2. Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (c) =>
          (c.phoneNumber && c.phoneNumber.includes(q)) ||
          (c.leadName && c.leadName.toLowerCase().includes(q))
      );
    }

    // 3. For Missed calls: group repeats from the same number with count badge
    if (categoryFilter === 'missed') {
      const groups = {};
      list.forEach((item) => {
        const phone = item.phoneNumber;
        if (!groups[phone]) {
          groups[phone] = {
            ...item,
            missedCount: 1,
            allTimestamps: [item.timestamp],
          };
        } else {
          groups[phone].missedCount += 1;
          groups[phone].allTimestamps.push(item.timestamp);
        }
      });
      list = Object.values(groups);
    } else if (categoryFilter === 'cnp') {
      // 4. For Not Picked (CNP): 1 customer dialed up to 3 times = 1 row with attempt badge
      const groups = {};
      list.forEach((item) => {
        const phone = item.phoneNumber;
        if (!groups[phone]) {
          groups[phone] = {
            ...item,
            attemptCount: 1,
            allTimestamps: [item.timestamp],
            latestTimestamp: item.timestamp,
            earliestTimestamp: item.timestamp,
          };
        } else {
          groups[phone].attemptCount += 1;
          groups[phone].allTimestamps.push(item.timestamp);
          if (new Date(item.timestamp).getTime() > new Date(groups[phone].latestTimestamp).getTime()) {
            groups[phone].latestTimestamp = item.timestamp;
            groups[phone].timestamp = item.timestamp;
            groups[phone]._id = item._id;
          }
          if (new Date(item.timestamp).getTime() < new Date(groups[phone].earliestTimestamp).getTime()) {
            groups[phone].earliestTimestamp = item.timestamp;
          }
        }
      });
      list = Object.values(groups).sort(
        (a, b) => new Date(b.latestTimestamp || b.timestamp).getTime() - new Date(a.latestTimestamp || a.timestamp).getTime()
      );
    } else if (categoryFilter === 'all') {
      // 5. In All Calls: collapse repeated CNP attempts to the same phone number
      const cnpGroups = {};
      const rest = [];
      list.forEach((item) => {
        const isCNP = item.callType === 'outgoing' && item.duration === 0;
        if (!isCNP) {
          rest.push(item);
        } else {
          const phone = item.phoneNumber;
          if (!cnpGroups[phone]) {
            cnpGroups[phone] = {
              ...item,
              attemptCount: 1,
              allTimestamps: [item.timestamp],
              latestTimestamp: item.timestamp,
              earliestTimestamp: item.timestamp,
            };
          } else {
            cnpGroups[phone].attemptCount += 1;
            cnpGroups[phone].allTimestamps.push(item.timestamp);
            if (new Date(item.timestamp).getTime() > new Date(cnpGroups[phone].latestTimestamp).getTime()) {
              cnpGroups[phone].latestTimestamp = item.timestamp;
              cnpGroups[phone].timestamp = item.timestamp;
              cnpGroups[phone]._id = item._id;
            }
            if (new Date(item.timestamp).getTime() < new Date(cnpGroups[phone].earliestTimestamp).getTime()) {
              cnpGroups[phone].earliestTimestamp = item.timestamp;
            }
          }
        }
      });
      list = [...rest, ...Object.values(cnpGroups)].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    }

    return list;
  }, [crmLogs, localLogs, categoryFilter, searchQuery]);

  // Connect rate calculation
  const connectRate = stats.dialedCalls > 0
    ? Math.round((stats.connectedCalls / stats.dialedCalls) * 100)
    : 0;

  // -------------------------------------------------------------
  // LOGIN SCREEN
  // -------------------------------------------------------------
  if (!user) {
    return (
      <SafeAreaView style={styles.loginContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#061208" />
        <View style={styles.loginBox}>
          {/* Brand Crest */}
          <View style={styles.brandIconWrapper}>
            <Text style={styles.brandEmoji}>🌿</Text>
          </View>
          <Text style={styles.brandTitle}>TRIVEN AYURVEDA</Text>
          <Text style={styles.brandSubtitle}>Staff Telecalling Tracker & CRM Sync</Text>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Employee Email or Phone</Text>
            <TextInput
              placeholder="e.g. satyendra@triven.com or 7309523829"
              placeholderTextColor="#52795d"
              value={email}
              onChangeText={setEmail}
              style={styles.input}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>CRM Password</Text>
            <TextInput
              placeholder="••••••••"
              placeholderTextColor="#52795d"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              style={styles.input}
            />
          </View>

          <TouchableOpacity
            style={styles.loginBtn}
            onPress={handleLogin}
            disabled={loginLoading}
            activeOpacity={0.8}
          >
            {loginLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.loginBtnText}>LOGIN TO TELECALLING DESK</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.loginFooter}>
            Official internal app for Triven Ayurveda telecallers & consultants.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // -------------------------------------------------------------
  // MAIN TELECALLING DESK SCREEN
  // -------------------------------------------------------------
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#061208" />

      {/* TOP HEADER: Profile Card */}
      <View style={styles.headerCard}>
        <View style={styles.headerLeft}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{user.name?.[0]?.toUpperCase() || 'E'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={styles.userName} numberOfLines={1}>{user.name}</Text>
              <View style={styles.empBadge}>
                <Text style={styles.empBadgeText}>{user.employeeId || 'STAFF'}</Text>
              </View>
            </View>
            <Text style={styles.userRole}>
              {user.role?.toUpperCase()} • {user.departments?.join(', ') || 'General'}
            </Text>
          </View>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.7}>
          <Text style={styles.logoutBtnText}>Logout</Text>
        </TouchableOpacity>
      </View>

      {/* LIVE SYNC STATUS BANNER */}
      <View style={styles.syncStatusCard}>
        <View style={styles.pulseDot} />
        <View style={{ flex: 1 }}>
          <Text style={styles.syncStatusTitle}>Auto-Sync Active (Every 20m & Post-Call)</Text>
          <Text style={styles.syncStatusSub}>
            Last synced with CRM: {lastSyncTime ? lastSyncTime : 'Connecting...'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.quickSyncBtn}
          onPress={syncCallsWithServer}
          disabled={syncing}
        >
          {syncing ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.quickSyncText}>🔄 Sync</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* FLASH NOTIFICATION BANNER */}
      {syncBanner && (
        <View style={styles.toastBanner}>
          <Text style={styles.toastText}>{syncBanner}</Text>
        </View>
      )}

      {/* TIME RANGE FILTER CHIPS */}
      <View style={styles.timeFilterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.timeFilterScroll}>
          {[
            { id: 'today', label: 'Today' },
            { id: 'yesterday', label: 'Yesterday' },
            { id: 'week', label: 'Last 7 Days' },
            { id: 'month', label: 'This Month' },
            { id: 'all', label: 'All Time' },
          ].map((f) => {
            const active = timeFilter === f.id;
            return (
              <TouchableOpacity
                key={f.id}
                onPress={() => setTimeFilter(f.id)}
                style={[styles.timeChip, active && styles.timeChipActive]}
              >
                <Text style={[styles.timeChipText, active && styles.timeChipTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* 5 DYNAMIC CRM METRICS CARDS */}
      <View style={styles.statsContainer}>
        <View style={styles.statsRow}>
          {/* Card 1: Total Dialed */}
          <View style={[styles.metricCard, { borderLeftColor: '#3b82f6' }]}>
            <Text style={styles.metricLabel}>Total Dialed</Text>
            <Text style={[styles.metricValue, { color: '#60a5fa' }]}>{stats.dialedCalls}</Text>
            <Text style={styles.metricSub}>
              {stats.connectedCalls} talked + {stats.cnpCalls} CNP
              {stats.totalDialAttempts && stats.totalDialAttempts > stats.dialedCalls ? ` (${stats.totalDialAttempts} dials)` : ''}
            </Text>
          </View>

          {/* Card 2: Connected */}
          <View style={[styles.metricCard, { borderLeftColor: '#10b981' }]}>
            <Text style={styles.metricLabel}>Connected</Text>
            <Text style={[styles.metricValue, { color: '#34d399' }]}>{stats.connectedCalls}</Text>
            <Text style={styles.metricSub}>{connectRate}% Connect Rate</Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          {/* Card 3: Not Picked */}
          <View style={[styles.metricCard, { borderLeftColor: '#f59e0b' }]}>
            <Text style={styles.metricLabel}>Not Picked (CNP)</Text>
            <Text style={[styles.metricValue, { color: '#fbbf24' }]}>{stats.cnpCalls}</Text>
            <Text style={styles.metricSub}>
              {stats.totalCnpAttempts && stats.totalCnpAttempts > stats.cnpCalls
                ? `${stats.totalCnpAttempts} attempts (${stats.cnpCalls} leads)`
                : "Customer didn't answer"}
            </Text>
          </View>

          {/* Card 4: Inbound Missed */}
          <View style={[styles.metricCard, { borderLeftColor: '#f43f5e' }]}>
            <Text style={styles.metricLabel}>Missed Inbound</Text>
            <Text style={[styles.metricValue, { color: '#fb7185' }]}>
              {stats.pendingMissedCalls || 0}
            </Text>
            <Text style={styles.metricSub}>
              {(stats.resolvedMissedCalls || stats.missedCalls || 0)} called back
            </Text>
          </View>
        </View>

        {/* Card 5: Full Width Talk-Time */}
        <View style={[styles.fullMetricCard, { borderLeftColor: '#a855f7' }]}>
          <View>
            <Text style={styles.metricLabel}>Total Customer Talk-Time</Text>
            <Text style={[styles.metricValue, { color: '#c084fc' }]}>{fmtDuration(stats.totalTalkTime)}</Text>
          </View>
          <View style={styles.avgBox}>
            <Text style={styles.avgLabel}>Average Call</Text>
            <Text style={styles.avgValue}>{fmtDuration(stats.avgDuration)}</Text>
          </View>
        </View>
      </View>

      {/* SEARCH BAR */}
      <View style={styles.searchBox}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          placeholder="Search customer phone or name..."
          placeholderTextColor="#52795d"
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={styles.searchInput}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Text style={styles.searchClear}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* CATEGORY FILTER TABS */}
      <View style={styles.tabBar}>
        {[
          { id: 'all', label: `All (${stats.dialedCalls + stats.missedCalls})` },
          { id: 'connected', label: `Connected (${stats.connectedCalls})` },
          { id: 'cnp', label: `CNP (${stats.cnpCalls})` },
          { id: 'missed', label: `Missed (${stats.pendingMissedCalls || 0})` },
        ].map((tab) => {
          const active = categoryFilter === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              onPress={() => setCategoryFilter(tab.id)}
              style={[styles.tabBtn, active && styles.tabBtnActive]}
            >
              <Text style={[styles.tabBtnText, active && styles.tabBtnTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* CALL LOGS LIST */}
      <FlatList
        data={displayedCalls}
        keyExtractor={(item, index) => String(item._id || item.timestamp || index)}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={syncAndRefreshAll}
            tintColor="#10b981"
            colors={['#10b981']}
          />
        }
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyEmoji}>📞</Text>
            <Text style={styles.emptyTitle}>No Calls Found</Text>
            <Text style={styles.emptySub}>
              {categoryFilter === 'missed' && stats.pendingMissedCalls === 0
                ? 'All customer missed calls have been called back!'
                : 'No calls found for this filter or time scope.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const isConnected = item.callType === 'outgoing' && item.duration > 0;
          const isCNP = item.callType === 'outgoing' && item.duration === 0;
          const isMissed = item.callType === 'missed';
          const isIncomingConnected = item.callType === 'incoming' && item.duration > 0;

          return (
            <View style={styles.callCard}>
              <View style={styles.callCardMain}>
                {/* Caller & Customer Info */}
                <View style={{ flex: 1 }}>
                  <Text style={styles.customerName} numberOfLines={1}>
                    {item.leadName || 'Customer Lead'}
                  </Text>
                  <Text style={styles.customerPhone}>{item.phoneNumber}</Text>
                  <Text style={styles.callTimestamp}>
                    {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} •{' '}
                    {new Date(item.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    {item.attemptCount > 1 && item.earliestTimestamp && item.earliestTimestamp !== item.latestTimestamp
                      ? ` • 1st: ${new Date(item.earliestTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                      : ''}
                  </Text>
                </View>

                {/* Status Badges & Duration */}
                <View style={styles.callBadgeCol}>
                  {isConnected && (
                    <View style={styles.badgeConnected}>
                      <Text style={styles.badgeConnectedText}>
                        CONNECTED • {fmtDuration(item.duration)}
                      </Text>
                    </View>
                  )}
                  {isCNP && (
                    <View style={styles.badgeCNP}>
                      <Text style={styles.badgeCNPText}>
                        NOT PICKED {item.attemptCount > 1 ? `(${item.attemptCount}x Attempts)` : '(0s)'}
                      </Text>
                    </View>
                  )}
                  {isMissed && (
                    <View style={styles.badgeMissed}>
                      <Text style={styles.badgeMissedText}>
                        MISSED {item.missedCount > 1 ? `(${item.missedCount}x)` : ''}
                      </Text>
                      <Text style={styles.badgeMissedStatus}>
                        {item.status === 'missed_resolved' ? '✓ Called Back' : '🔴 Needs Callback'}
                      </Text>
                    </View>
                  )}
                  {isIncomingConnected && (
                    <View style={styles.badgeConnected}>
                      <Text style={styles.badgeConnectedText}>
                        INCOMING • {fmtDuration(item.duration)}
                      </Text>
                    </View>
                  )}

                  {/* One-Tap Redial Button */}
                  <TouchableOpacity
                    style={styles.dialBtn}
                    onPress={() => handleDial(item.phoneNumber)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.dialBtnText}>📞 Call Now</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

// -------------------------------------------------------------
// STYLES
// -------------------------------------------------------------
const styles = StyleSheet.create({
  // Login
  loginContainer: {
    flex: 1,
    backgroundColor: '#061208',
    justifyContent: 'center',
    padding: 20,
  },
  loginBox: {
    backgroundColor: '#0c2211',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: '#183c1f',
  },
  brandIconWrapper: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#13351a',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  brandEmoji: { fontSize: 32 },
  brandTitle: {
    color: '#34d399',
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 1.2,
  },
  brandSubtitle: {
    color: '#86efac',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 24,
  },
  inputGroup: { marginBottom: 16 },
  inputLabel: {
    color: '#a7f3d0',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#061208',
    color: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1a4623',
    fontSize: 14,
  },
  loginBtn: {
    backgroundColor: '#10b981',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: '#10b981',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  loginBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  loginFooter: {
    color: '#52795d',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 20,
    lineHeight: 16,
  },

  // Main Container
  container: {
    flex: 1,
    backgroundColor: '#061208',
    paddingTop: 8,
  },

  // Header Card
  headerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0c2211',
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#183c1f',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '900',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  userName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    maxWidth: 160,
  },
  empBadge: {
    backgroundColor: '#13351a',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1d4d26',
  },
  empBadgeText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '700',
  },
  userRole: {
    color: '#86efac',
    fontSize: 11,
    marginTop: 2,
  },
  logoutBtn: {
    backgroundColor: '#261214',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#4d1e23',
  },
  logoutBtnText: {
    color: '#fb7185',
    fontSize: 11,
    fontWeight: '700',
  },

  // Sync Status Card
  syncStatusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#081a0d',
    marginHorizontal: 12,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#14381b',
  },
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
    marginRight: 8,
  },
  syncStatusTitle: {
    color: '#a7f3d0',
    fontSize: 11,
    fontWeight: '700',
  },
  syncStatusSub: {
    color: '#6ee7b7',
    fontSize: 10,
    marginTop: 1,
  },
  quickSyncBtn: {
    backgroundColor: '#10b981',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  quickSyncText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },

  // Toast
  toastBanner: {
    backgroundColor: '#064e3b',
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#059669',
  },
  toastText: {
    color: '#a7f3d0',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },

  // Time Filters
  timeFilterContainer: {
    marginHorizontal: 12,
    marginBottom: 10,
  },
  timeFilterScroll: {
    gap: 6,
  },
  timeChip: {
    backgroundColor: '#0b2110',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#183c1f',
  },
  timeChipActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  timeChipText: {
    color: '#86efac',
    fontSize: 11,
    fontWeight: '600',
  },
  timeChipTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },

  // Stats Grid
  statsContainer: {
    marginHorizontal: 12,
    marginBottom: 10,
    gap: 8,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#0c2211',
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#183c1f',
    borderLeftWidth: 4,
  },
  fullMetricCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0c2211',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#183c1f',
    borderLeftWidth: 4,
  },
  metricLabel: {
    color: '#86efac',
    fontSize: 11,
    fontWeight: '600',
  },
  metricValue: {
    fontSize: 18,
    fontWeight: '900',
    marginTop: 2,
  },
  metricSub: {
    color: '#52795d',
    fontSize: 10,
    fontWeight: '500',
    marginTop: 2,
  },
  avgBox: {
    alignItems: 'flex-end',
  },
  avgLabel: {
    color: '#86efac',
    fontSize: 10,
  },
  avgValue: {
    color: '#e9d5ff',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },

  // Search
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0c2211',
    marginHorizontal: 12,
    marginBottom: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#183c1f',
  },
  searchIcon: { fontSize: 13, marginRight: 6 },
  searchInput: {
    flex: 1,
    color: '#ffffff',
    paddingVertical: 8,
    fontSize: 12,
  },
  searchClear: {
    color: '#86efac',
    fontSize: 14,
    padding: 4,
  },

  // Category Tabs
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginBottom: 10,
    backgroundColor: '#081a0d',
    borderRadius: 10,
    padding: 3,
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 8,
    alignItems: 'center',
  },
  tabBtnActive: {
    backgroundColor: '#10b981',
  },
  tabBtnText: {
    color: '#6ee7b7',
    fontSize: 10,
    fontWeight: '600',
  },
  tabBtnTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },

  // List
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 24,
    gap: 8,
  },
  callCard: {
    backgroundColor: '#0c2211',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#183c1f',
  },
  callCardMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  customerName: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  customerPhone: {
    color: '#86efac',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  callTimestamp: {
    color: '#52795d',
    fontSize: 10,
    marginTop: 4,
  },
  callBadgeCol: {
    alignItems: 'flex-end',
    gap: 6,
  },
  badgeConnected: {
    backgroundColor: '#064e3b',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#059669',
  },
  badgeConnectedText: {
    color: '#34d399',
    fontSize: 9,
    fontWeight: '800',
  },
  badgeCNP: {
    backgroundColor: '#451a03',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#b45309',
  },
  badgeCNPText: {
    color: '#fbbf24',
    fontSize: 9,
    fontWeight: '800',
  },
  badgeMissed: {
    backgroundColor: '#4c0519',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e11d48',
    alignItems: 'flex-end',
  },
  badgeMissedText: {
    color: '#f43f5e',
    fontSize: 9,
    fontWeight: '800',
  },
  badgeMissedStatus: {
    color: '#fda4af',
    fontSize: 8,
    fontWeight: '600',
    marginTop: 1,
  },
  dialBtn: {
    backgroundColor: '#13351a',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1d4d26',
  },
  dialBtnText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '700',
  },

  // Empty State
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyEmoji: { fontSize: 36, marginBottom: 8 },
  emptyTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  emptySub: {
    color: '#52795d',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    maxWidth: 240,
  },
});

registerRootComponent(App);
