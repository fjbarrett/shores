import Link from "next/link";

export const metadata = { title: "About" };

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 lg:px-12">
      <Link
        href="/"
        className="font-mono text-sm text-slate-500 transition hover:text-slate-300"
      >
        ← back
      </Link>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-slate-100">About</h1>

      <div className="mt-5 space-y-4 text-lg leading-relaxed text-slate-300">
        <p>
          <span className="text-slate-100">FiveNines Availability</span> is a
          browser-based application that regularly measures uptime and downtime of major cloud
          providers.
        </p>
      </div>
    </div>
  );
}
