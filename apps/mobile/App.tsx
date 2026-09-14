import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { canAdvance, officeDateKey, pricingDefaults, quote } from '@ag/rules';

/**
 * Scaffold screen. It exists to prove one thing: the pricing engine and the
 * clock rules that the office relies on run unchanged on the phone, from the
 * same source the server uses. Replace this with the driver's day view.
 */

const OFFICE_TIME_ZONE = 'America/New_York';

const sample = quote(
  { transport: 'Wheelchair', serviceDate: '2026-09-14', scheduledTime: '09:00' },
  pricingDefaults(),
  { miles: 12, today: '2026-09-14' },
);

export default function App() {
  // Late evening UTC is still the previous day in the office. The office's
  // clock decides the date, never the phone's.
  const officeDay = officeDateKey(new Date(), OFFICE_TIME_ZONE);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.heading}>Shared rules are running</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Today, by the office clock</Text>
        <Text style={styles.value}>{officeDay}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Sample price — wheelchair, 12 miles</Text>
        {sample.lines.map((line) => (
          <View key={line.key} style={styles.row}>
            <Text style={styles.rowLabel}>{line.label}</Text>
            <Text style={styles.rowAmount}>${line.amount.toFixed(2)}</Text>
          </View>
        ))}
        <View style={[styles.row, styles.totalRow]}>
          <Text style={styles.rowLabel}>Total</Text>
          <Text style={styles.rowAmount}>${sample.total.toFixed(2)}</Text>
        </View>
        {sample.incomplete ? (
          <Text style={styles.warning}>
            This price is not complete. It is not safe to invoice yet.
          </Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>A tap can only move forward</Text>
        <Text style={styles.value}>
          Not started → In route: {canAdvance('', 'IN ROUTE') ? 'allowed' : 'blocked'}
        </Text>
        <Text style={styles.value}>
          Complete → In route: {canAdvance('COMPLETE', 'IN ROUTE') ? 'allowed' : 'blocked'}
        </Text>
      </View>

      <StatusBar style="auto" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, paddingTop: 72, gap: 16, backgroundColor: '#f6f6f7' },
  heading: { fontSize: 22, fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 6 },
  label: { fontSize: 13, color: '#6b7280', marginBottom: 4 },
  value: { fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  totalRow: { marginTop: 8, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 8 },
  rowLabel: { fontSize: 15, flexShrink: 1, paddingRight: 12 },
  rowAmount: { fontSize: 15, fontVariant: ['tabular-nums'] },
  warning: { marginTop: 8, fontSize: 13, color: '#b45309' },
});
