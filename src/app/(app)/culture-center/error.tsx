'use client'
export default function CultureError({ reset }: { reset: () => void }) {
  return <div className="p-10 text-white"><h1 className="text-3xl font-bold">Culture Center is unavailable</h1><p className="my-5 text-gray-400">Kit couldn’t load the saved rules. Check the database migration and Slack connection. No schedules have been changed.</p><button className="border px-5 py-3" onClick={reset}>Try again</button></div>
}
