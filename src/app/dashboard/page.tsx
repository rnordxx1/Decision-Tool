import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { Suspense } from 'react'

/**
 * Server-side dashboard page.  Verifies that the user has a valid session via
 * Supabase Auth and, if authenticated, fetches and aggregates response data
 * from the `public.hns_responses` table.  The results are displayed as
 * simple KPI cards, a category distribution table, stacked breakdown tables,
 * and summary statistics about priorities and top reasons.
 */
export default async function DashboardPage() {
  // Check for a valid session using the cookie-based server client.  If there
  // isn't a valid session, redirect the user back to the login page.
  const supabaseServer = createServerSupabaseClient()
  const {
    data: { session },
  } = await supabaseServer.auth.getSession()
  if (!session) {
    redirect('/login')
  }

  // Use an admin client (service role key) to read all responses.  This
  // bypasses Row Level Security so only run on the server.
  const admin = createAdminClient()
  const { data: responses, error } = await admin.from('hns_responses').select('*')
  if (error) {
    throw new Error('Failed to fetch responses: ' + error.message)
  }
  const totalResponses = responses?.length ?? 0

  // Count recommendations (Inspire, Genio, Tie)
  const recCounts: Record<string, number> = {}
  responses?.forEach((r) => {
    const rec = (r.recommendation ?? 'Unknown') as string
    recCounts[rec] = (recCounts[rec] ?? 0) + 1
  })

  // Count responses in the last 7 days (requires created_at column)
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  let last7Days = 0
  responses?.forEach((r) => {
    const ts = (r.created_at || r.inserted_at) as string | undefined
    if (ts) {
      const dt = new Date(ts)
      if (dt >= sevenDaysAgo) last7Days++
    }
  })

  // Category distribution by recommendation
  const categories = recCounts

  // Build stacked breakdown by demographic fields
  const breakdownFields = [
    'ageRange',
    'sexAtBirth',
    'bmiRange',
    'insurance',
    'cpap',
    'stage',
    'heard',
    'country',
    'state',
  ]
  type Breakdown = Record<
    string,
    Record<string, { Inspire?: number; Genio?: number; Tie?: number; Unknown?: number }>
  >
  const breakdown: Breakdown = {}
  for (const field of breakdownFields) {
    breakdown[field] = {}
  }
  responses?.forEach((r) => {
    const rec = (r.recommendation ?? 'Unknown') as 'Inspire' | 'Genio' | 'Tie' | 'Unknown'
    const demographics = r.demographics || {}
    breakdownFields.forEach((field) => {
      const value = demographics[field] ?? 'Unknown'
      const entry = (breakdown[field][value] ?? {}) as {
        Inspire?: number
        Genio?: number
        Tie?: number
        Unknown?: number
      }
      entry[rec] = (entry[rec] ?? 0) + 1
      breakdown[field][value] = entry
    })
  })

  // Compute average slider values by winner (recommendation) group
  const sliderSums: Record<string, Record<string, { sum: number; count: number }>> = {}
  responses?.forEach((r) => {
    const rec = (r.recommendation ?? 'Unknown') as string
    const priorities = r.priorities || {}
    Object.keys(priorities).forEach((key) => {
      const value = Number(priorities[key])
      if (!Number.isFinite(value)) return
      sliderSums[rec] ??= {}
      sliderSums[rec][key] ??= { sum: 0, count: 0 }
      sliderSums[rec][key].sum += value
      sliderSums[rec][key].count += 1
    })
  })
  const sliderAverages: Record<string, Record<string, number>> = {}
  Object.keys(sliderSums).forEach((rec) => {
    sliderAverages[rec] = {}
    Object.keys(sliderSums[rec]).forEach((key) => {
      const { sum, count } = sliderSums[rec][key]
      sliderAverages[rec][key] = count > 0 ? sum / count : 0
    })
  })

  // Compute frequency of top reasons overall and by recommendation
  const topReasonFreq: Record<string, number> = {}
  responses?.forEach((r) => {
    const reasons = r.top_reasons || []
    if (Array.isArray(reasons)) {
      reasons.forEach((reason) => {
        topReasonFreq[reason] = (topReasonFreq[reason] ?? 0) + 1
      })
    }
  })

  // Build a CSV export of all responses.  This is done server‑side so the
  // download link can be generated without exposing the service role key.
  let csvUri: string | null = null
  if (responses && responses.length > 0) {
    const header = Object.keys(responses[0])
    const lines = [header.join(',')]
    responses.forEach((row) => {
      const values = header.map((col) => {
        const val = row[col]
        // JSON stringify objects/arrays and escape quotes
        let text = ''
        if (val === null || val === undefined) {
          text = ''
        } else if (typeof val === 'object') {
          text = JSON.stringify(val)
        } else {
          text = String(val)
        }
        // escape any double quotes by doubling them
        text = text.replace(/"/g, '""')
        // wrap in quotes if it contains a comma or newline
        return /[",\n]/.test(text) ? `"${text}"` : text
      })
      lines.push(values.join(','))
    })
    const csvContent = lines.join('\n')
    csvUri = `data:text/csv;charset=utf-8,${encodeURIComponent(csvContent)}`
  }

  return (
    <main className="p-4">
      <h1 className="text-3xl font-bold mb-6">HNS Decision Tool Dashboard</h1>
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="p-4 border rounded-md shadow">
          <h2 className="text-xl font-medium">Total Responses</h2>
          <p className="text-3xl font-bold">{totalResponses}</p>
        </div>
        <div className="p-4 border rounded-md shadow">
          <h2 className="text-xl font-medium">Inspire / Genio / Tie</h2>
          <p className="text-3xl font-bold">
            {recCounts['Inspire'] ?? 0} / {recCounts['Genio'] ?? 0} / {recCounts['Tie'] ?? 0}
          </p>
        </div>
        <div className="p-4 border rounded-md shadow">
          <h2 className="text-xl font-medium">Last 7 Days</h2>
          <p className="text-3xl font-bold">{last7Days}</p>
        </div>
      </section>

      {/* Category distribution table */}
      <section className="mb-8">
        <h2 className="text-2xl font-medium mb-4">Recommendation Distribution</h2>
        <table className="w-full border border-collapse">
          <thead>
            <tr>
              <th className="border px-2 py-1 text-left">Recommendation</th>
              <th className="border px-2 py-1 text-right">Count</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(categories).map((key) => (
              <tr key={key}>
                <td className="border px-2 py-1">{key}</td>
                <td className="border px-2 py-1 text-right">{categories[key]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Stacked breakdown tables */}
      <section className="mb-8">
        <h2 className="text-2xl font-medium mb-4">Demographic Breakdown</h2>
        {breakdownFields.map((field) => (
          <div key={field} className="mb-6">
            <h3 className="text-xl font-semibold mb-2">{field}</h3>
            <table className="w-full border border-collapse mb-2">
              <thead>
                <tr>
                  <th className="border px-2 py-1 text-left">Value</th>
                  <th className="border px-2 py-1 text-right">Inspire</th>
                  <th className="border px-2 py-1 text-right">Genio</th>
                  <th className="border px-2 py-1 text-right">Tie</th>
                  <th className="border px-2 py-1 text-right">Unknown</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(breakdown[field]).map(([value, counts]) => (
                  <tr key={value}>
                    <td className="border px-2 py-1">{value}</td>
                    <td className="border px-2 py-1 text-right">{counts['Inspire'] ?? 0}</td>
                    <td className="border px-2 py-1 text-right">{counts['Genio'] ?? 0}</td>
                    <td className="border px-2 py-1 text-right">{counts['Tie'] ?? 0}</td>
                    <td className="border px-2 py-1 text-right">{counts['Unknown'] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {/* Slider averages */}
      <section className="mb-8">
        <h2 className="text-2xl font-medium mb-4">Average Slider Values by Recommendation</h2>
        {Object.keys(sliderAverages).map((rec) => (
          <div key={rec} className="mb-4">
            <h3 className="text-xl font-semibold mb-2">{rec}</h3>
            <table className="w-full border border-collapse">
              <thead>
                <tr>
                  <th className="border px-2 py-1 text-left">Slider</th>
                  <th className="border px-2 py-1 text-right">Average Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(sliderAverages[rec]).map(([key, avg]) => (
                  <tr key={key}>
                    <td className="border px-2 py-1">{key}</td>
                    <td className="border px-2 py-1 text-right">{avg.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {/* Top reasons frequency */}
      <section className="mb-8">
        <h2 className="text-2xl font-medium mb-4">Top Reasons Frequency</h2>
        <table className="w-full border border-collapse">
          <thead>
            <tr>
              <th className="border px-2 py-1 text-left">Reason</th>
              <th className="border px-2 py-1 text-right">Count</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(topReasonFreq)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <tr key={reason}>
                  <td className="border px-2 py-1">{reason}</td>
                  <td className="border px-2 py-1 text-right">{count}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      {/* Raw data table */}
      <section className="mb-8">
        <h2 className="text-2xl font-medium mb-4">Raw Responses</h2>
        {csvUri && (
          <div className="mb-2">
            <a
              href={csvUri}
              download="hns_responses.csv"
              className="text-blue-600 underline"
            >
              Export CSV
            </a>
          </div>
        )}
        <div className="overflow-auto border rounded-md">
          <table className="min-w-full text-sm border-collapse">
            <thead className="bg-gray-50">
              <tr>
                {responses && responses.length > 0 &&
                  Object.keys(responses[0]).map((col) => (
                    <th key={col} className="border px-2 py-1 whitespace-nowrap text-left">
                      {col}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {responses?.map((row, idx) => (
                <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  {Object.keys(row).map((col) => (
                    <td key={col} className="border px-2 py-1 whitespace-nowrap">
                      {typeof row[col] === 'object' ? JSON.stringify(row[col]) : String(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}