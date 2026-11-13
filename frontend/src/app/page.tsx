import type { Metadata } from "next";
import Link from "next/link";

/**
 * CaaS marketing homepage.
 * Replace: frontend/src/app/page.tsx
 * No backend changes, new dependencies, or image hosting required.
 * All illustration data is intentionally decorative (not real experiment data).
 */

export const metadata: Metadata = {
  title: "CaaS | Discover the patterns in your data",
  description:
    "CaaS gives your data a clearer direction. Upload CSV files, explore K-Means clustering, and turn hidden patterns into understandable results.",
};

const benefits = [
  {
    number: "01",
    title: "Focus on what matters",
    description:
      "Move from rows and columns to meaningful groups, with a workspace built around understanding your data.",
    color: "#315FE6",
    icon: "focus",
  },
  {
    number: "02",
    title: "Explore with confidence",
    description:
      "Choose how your data is prepared and clustered, with a transparent, repeatable approach behind every run.",
    color: "#0B978F",
    icon: "layers",
  },
  {
    number: "03",
    title: "Keep the bigger picture",
    description:
      "See the story behind your clusters, revisit your experiments, and take your findings with you.",
    color: "#7A62D8",
    icon: "insights",
  },
] as const;

const journey = [
  {
    number: "01",
    title: "Bring your data",
    description: "Start with a CSV and choose the information you want to explore.",
  },
  {
    number: "02",
    title: "Discover its structure",
    description: "Run a configurable K-Means clustering experiment.",
  },
  {
    number: "03",
    title: "Understand what you found",
    description: "Explore the visual results, compare groups, and save your work.",
  },
] as const;

const leftDots: [number, number, number][] = [
  [78, 280, 4], [91, 315, 5], [111, 292, 4], [123, 339, 5], [139, 271, 6],
  [147, 309, 4], [163, 327, 5], [169, 287, 4], [182, 356, 5], [193, 316, 6],
  [202, 273, 4], [217, 341, 5], [225, 299, 4], [244, 324, 5], [157, 366, 4],
  [103, 361, 4], [66, 342, 4], [209, 375, 3], [128, 384, 3], [250, 362, 4],
];
const centerDots: [number, number, number][] = [
  [242, 149, 4], [266, 174, 5], [285, 125, 5], [295, 187, 4], [312, 152, 6],
  [328, 216, 4], [335, 128, 5], [350, 177, 5], [371, 149, 4], [389, 197, 5],
  [407, 165, 4], [281, 232, 3], [310, 249, 4], [362, 236, 4], [394, 121, 3],
  [352, 95, 4], [253, 217, 4], [431, 196, 4], [375, 268, 3], [293, 86, 3],
];
const rightDots: [number, number, number][] = [
  [389, 318, 4], [411, 292, 5], [432, 339, 5], [444, 285, 4], [461, 313, 6],
  [476, 360, 4], [486, 280, 5], [500, 333, 4], [520, 305, 5], [528, 365, 4],
  [546, 340, 4], [405, 372, 4], [454, 388, 3], [502, 396, 3], [567, 317, 3],
  [425, 409, 3], [547, 395, 4], [474, 243, 3], [558, 277, 3], [382, 389, 3],
];

function ArrowIcon({ diagonal = false }: { diagonal?: boolean }) {
  return diagonal ? (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 19 19 5M8 5h11v11" />
    </svg>
  ) : (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h16m-7-7 7 7-7 7" />
    </svg>
  );
}

function BrandMark({ inverted = false }: { inverted?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${inverted ? "text-white" : "text-[#18263e]"}`}>
      <span className={`relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] ${inverted ? "bg-white/12 ring-1 ring-white/20" : "bg-[#19263E]"}`} aria-hidden="true">
        <span className="relative block h-[19px] w-[19px]">
          <span className="absolute left-0 top-0 h-[7px] w-[7px] rounded-[2px] bg-white" />
          <span className="absolute right-0 top-[5px] h-[7px] w-[7px] rounded-[2px] bg-[#9BAEFF]" />
          <span className="absolute bottom-0 left-[5px] h-[7px] w-[7px] rounded-[2px] bg-[#6BDEC4]" />
        </span>
      </span>
      <span className="text-[23px] font-bold tracking-[-0.075em]">caas<span className={inverted ? "text-[#8FA8FF]" : "text-[#315FE6]"}>.</span></span>
    </span>
  );
}

function BenefitIcon({ name, color }: { name: "focus" | "layers" | "insights"; color: string }) {
  const common = {
    width: 25,
    height: 25,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  if (name === "focus") {
    return <svg {...common}><path d="M7 3H5a2 2 0 0 0-2 2v2m14-4h2a2 2 0 0 1 2 2v2M3 17v2a2 2 0 0 0 2 2h2m14-4v2a2 2 0 0 1-2 2h-2" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" fill={color} stroke="none" /></svg>;
  }
  if (name === "layers") {
    return <svg {...common}><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></svg>;
  }
  return <svg {...common}><path d="M4 19V5m0 14h16M8 14l4-4 3 3 5-7" /><path d="M16.5 6H20v3.5" /></svg>;
}

function ClusterArtwork() {
  return (
    <div className="relative mx-auto aspect-[1.08] w-full max-w-[620px] overflow-visible" role="img" aria-label="Abstract illustration showing scattered data points forming three colorful groups">
      <div className="absolute inset-[9%_6%_9%_7%] rounded-full bg-[radial-gradient(ellipse_at_48%_45%,#ffffff_0%,#ecf4ff_41%,#e8eeff_66%,transparent_76%)] blur-[5px]" />
      <div className="absolute inset-[9%_8%_10%_8%] rounded-full border border-[#D9E7FA]/70" />
      <div className="absolute inset-[21%_20%_21%_20%] rounded-full border border-dashed border-[#C9D7ED]" />
      <svg viewBox="0 0 630 520" className="relative h-full w-full overflow-visible" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <radialGradient id="halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#E4EDFF" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#E4EDFF" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="connection" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#315FE6" stopOpacity="0.25" />
            <stop offset="0.5" stopColor="#0BAA9B" stopOpacity="0.15" />
            <stop offset="1" stopColor="#8772E8" stopOpacity="0.2" />
          </linearGradient>
          <filter id="softShadow"><feDropShadow dx="0" dy="9" stdDeviation="13" floodColor="#203F73" floodOpacity="0.13" /></filter>
        </defs>
        <circle cx="313" cy="250" r="225" fill="url(#halo)" />
        <g stroke="url(#connection)" strokeWidth="1.4" strokeDasharray="5 7" fill="none">
          <path d="M155 318 C208 250 240 211 317 172" />
          <path d="M317 172 C379 212 431 265 472 333" />
          <path d="M155 318 C260 388 366 400 472 333" />
        </g>
        <g opacity="0.55" stroke="#C9D7EA" strokeWidth="1" fill="none">
          <circle cx="315" cy="252" r="118" strokeDasharray="2 9" />
          <circle cx="315" cy="252" r="181" strokeDasharray="3 10" />
          <path d="M315 45V65M315 446v20M86 253h20M523 253h20" />
        </g>
        <circle cx="161" cy="317" r="113" fill="#E4ECFF" fillOpacity="0.50" stroke="#C8D8FF" strokeOpacity="0.8" />
        <circle cx="332" cy="168" r="113" fill="#DFFAF5" fillOpacity="0.43" stroke="#B9EDE5" strokeOpacity="0.83" />
        <circle cx="473" cy="333" r="107" fill="#F0ECFF" fillOpacity="0.5" stroke="#DED6FF" strokeOpacity="0.84" />
        <g fill="#416CE8">
          {leftDots.map(([cx, cy, r], i) => <circle key={`left-${i}`} cx={cx} cy={cy} r={r} opacity={i % 4 === 0 ? 0.52 : 0.86} />)}
        </g>
        <g fill="#18A89D">
          {centerDots.map(([cx, cy, r], i) => <circle key={`center-${i}`} cx={cx} cy={cy} r={r} opacity={i % 4 === 0 ? 0.52 : 0.87} />)}
        </g>
        <g fill="#927BE7">
          {rightDots.map(([cx, cy, r], i) => <circle key={`right-${i}`} cx={cx} cy={cy} r={r} opacity={i % 4 === 0 ? 0.56 : 0.86} />)}
        </g>
        <g filter="url(#softShadow)">
          <g transform="translate(92 181)">
            <rect width="93" height="37" rx="18.5" fill="white" stroke="#E1E9F4" />
            <circle cx="19" cy="18.5" r="5" fill="#416CE8" />
            <text x="32" y="23" fontFamily="Arial, sans-serif" fontSize="12" fontWeight="600" fill="#3A4A64">Group A</text>
          </g>
          <g transform="translate(386 73)">
            <rect width="93" height="37" rx="18.5" fill="white" stroke="#E1E9F4" />
            <circle cx="19" cy="18.5" r="5" fill="#18A89D" />
            <text x="32" y="23" fontFamily="Arial, sans-serif" fontSize="12" fontWeight="600" fill="#3A4A64">Group B</text>
          </g>
          <g transform="translate(443 425)">
            <rect width="93" height="37" rx="18.5" fill="white" stroke="#E1E9F4" />
            <circle cx="19" cy="18.5" r="5" fill="#927BE7" />
            <text x="32" y="23" fontFamily="Arial, sans-serif" fontSize="12" fontWeight="600" fill="#3A4A64">Group C</text>
          </g>
        </g>
        <g fill="white" stroke="#CBD9F0" strokeWidth="2">
          <circle cx="315" cy="252" r="8" />
        </g>
        <circle cx="315" cy="252" r="3" fill="#526BE3" />
      </svg>
      <span className="absolute bottom-[7%] left-[5%] hidden items-center gap-2 rounded-full border border-[#DDE7F6] bg-white/95 px-4 py-2 text-[11px] font-medium text-[#687A98] shadow-[0_10px_30px_rgba(47,76,122,0.08)] sm:inline-flex">
        <span className="inline-block h-2 w-2 rounded-full bg-[#40B8A9]" />
        Different points. Clearer patterns.
      </span>
    </div>
  );
}

function JourneyArtwork() {
  return (
    <div className="relative flex min-h-[340px] items-center justify-center overflow-hidden rounded-[26px] bg-[#16263F] px-5 py-10 sm:min-h-[420px]" aria-hidden="true">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_73%_21%,rgba(75,112,235,0.38),transparent_50%),radial-gradient(ellipse_at_14%_88%,rgba(39,171,161,0.18),transparent_43%)]" />
      <div className="absolute inset-0 opacity-[0.16]" style={{ backgroundImage: "linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)", backgroundSize: "46px 46px" }} />
      <svg viewBox="0 0 520 350" className="relative w-full max-w-[520px]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="flow" x1="0" x2="1"><stop stopColor="#75A1FF" /><stop offset="1" stopColor="#63E1C8" /></linearGradient>
        </defs>
        <g stroke="#7990B6" strokeOpacity=".23" fill="none">
          <rect x="20" y="60" width="126" height="222" rx="16" />
          <rect x="190" y="60" width="130" height="222" rx="16" />
          <rect x="364" y="60" width="136" height="222" rx="16" />
        </g>
        <g stroke="url(#flow)" strokeWidth="2" fill="none" strokeLinecap="round">
          <path d="M148 173h38m-9-9 9 9-9 9" />
          <path d="M324 173h36m-9-9 9 9-9 9" />
        </g>
        <g stroke="#B5C7E3" strokeWidth="2" fill="none" strokeLinecap="round">
          <rect x="50" y="98" width="66" height="82" rx="7" />
          <path d="M64 117h36M64 131h36M64 145h36M64 159h22" />
        </g>
        <g fill="#97ADDE"><circle cx="65" cy="118" r="3" /><circle cx="65" cy="132" r="3" /><circle cx="65" cy="146" r="3" /></g>
        <g fill="#B0C7FF">
          {[ [216,114],[241,138],[271,101],[291,148],[217,181],[247,171],[287,195],[227,214],[274,226],[298,119] ].map(([x,y],i)=><circle key={`mid-${i}`} cx={x} cy={y} r="5" opacity={i%2 ? .65 : 1} />)}
        </g>
        <g fill="#78DCCB">
          {[ [401,112],[417,125],[394,137],[429,103],[417,153],[448,141] ].map(([x,y],i)=><circle key={`out-a-${i}`} cx={x} cy={y} r="5" opacity={i%2 ? .6 : 1} />)}
        </g>
        <g fill="#93ACFF">
          {[ [440,180],[461,195],[423,200],[447,219],[475,221],[464,174] ].map(([x,y],i)=><circle key={`out-b-${i}`} cx={x} cy={y} r="5" opacity={i%2 ? .6 : 1} />)}
        </g>
        <g fill="#D6C3FF">
          {[ [393,202],[409,226],[379,229],[402,251],[427,250],[383,255] ].map(([x,y],i)=><circle key={`out-c-${i}`} cx={x} cy={y} r="5" opacity={i%2 ? .6 : 1} />)}
        </g>
        <g fill="#C9D7EA" fontFamily="Arial, sans-serif" textAnchor="middle" fontSize="13" fontWeight="600">
          <text x="83" y="241">Your data</text><text x="255" y="241">Explore</text><text x="432" y="272">Patterns</text>
        </g>
      </svg>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-white font-sans text-[#17263E] antialiased">
      <header className="relative z-20 border-b border-[#E7EBF1] bg-white/95">
        <div className="mx-auto flex h-[76px] max-w-[1240px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
          <Link href="/" className="inline-flex items-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#315FE6]" aria-label="CaaS homepage"><BrandMark /></Link>
          <nav className="hidden items-center gap-8 text-[13px] font-medium text-[#596B84] md:flex" aria-label="Primary navigation">
            <a href="#why-caas" className="transition-colors hover:text-[#315FE6]">Why CaaS</a>
            <a href="#how-it-works" className="transition-colors hover:text-[#315FE6]">How it works</a>
          </nav>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <Link href="/login" className="rounded-lg px-2.5 py-2 text-[12px] font-semibold text-[#283850] transition-colors hover:text-[#315FE6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315FE6] sm:px-4 sm:text-[13px]">Sign in</Link>
            <Link href="/register" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#315FE6] px-3.5 text-[12px] font-semibold text-white shadow-[0_6px_14px_rgba(49,95,230,.16)] transition-all hover:bg-[#254FD0] hover:shadow-[0_9px_18px_rgba(49,95,230,.22)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#315FE6] sm:px-5 sm:text-[13px]">Get started <span className="hidden sm:inline"><ArrowIcon /></span></Link>
          </div>
        </div>
      </header>

      <main>
        {/* Outcome-led hero: the visual is brand artwork, not a fake product dashboard. */}
        <section className="relative isolate overflow-hidden bg-[linear-gradient(113deg,#FFFFFF_1%,#F8FBFF_53%,#EFF5FF_100%)]">
          <div className="pointer-events-none absolute -right-[16%] top-[-180px] h-[480px] w-[620px] rounded-full bg-[#E7EEFF]/50 blur-[110px]" />
          <div className="mx-auto grid max-w-[1240px] items-center gap-8 px-5 py-16 sm:px-8 sm:py-20 md:gap-3 lg:min-h-[660px] lg:grid-cols-[0.98fr_1.02fr] lg:px-10 lg:py-16">
            <div className="relative z-10 max-w-[600px]">
              <span className="inline-flex items-center gap-2 rounded-full border border-[#DCE6FA] bg-white px-3.5 py-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[#4565AC] shadow-[0_2px_12px_rgba(56,88,140,.035)] sm:text-[11px]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#315FE6]" />
                A smarter perspective on data
              </span>
              <h1 className="mt-7 max-w-[650px] text-[clamp(44px,5.1vw,72px)] font-semibold leading-[1.07] tracking-[-0.065em] text-[#16243D]">
                Make sense of <span className="text-[#315FE6]">your data.</span>
              </h1>
              <p className="mt-7 max-w-[500px] text-[16px] leading-[1.85] text-[#60718A] sm:text-[17px]">
                Great insights start with seeing things differently. Discover meaningful groups, explore hidden patterns, and understand what your data is telling you—all in one clear workspace.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link href="/register" className="inline-flex min-h-[51px] items-center justify-center gap-2.5 rounded-[10px] bg-[#315FE6] px-6 text-[13px] font-semibold text-white shadow-[0_12px_23px_rgba(49,95,230,.18)] transition-all hover:-translate-y-0.5 hover:bg-[#254FD0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#315FE6]">Get started <ArrowIcon /></Link>
                <a href="#how-it-works" className="inline-flex min-h-[51px] items-center justify-center gap-2 rounded-[10px] border border-[#D7E0ED] bg-white px-6 text-[13px] font-semibold text-[#233653] transition-colors hover:border-[#8CA4F3] hover:text-[#315FE6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#315FE6]">See how it works</a>
              </div>
              <p className="mt-6 text-[12px] text-[#8A99AC]">Already have an account? <Link href="/login" className="font-semibold text-[#315FE6] underline-offset-4 hover:underline">Sign in to CaaS</Link></p>
            </div>
            <div className="relative -mx-3 mt-2 sm:mx-auto sm:w-full lg:mt-0 lg:translate-x-5"><ClusterArtwork /></div>
          </div>
        </section>

        <section className="border-y border-[#E8EDF5] bg-white" aria-label="CaaS product promise">
          <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-center gap-x-7 gap-y-3 px-5 py-6 text-center text-[12px] font-medium text-[#6D7E95] sm:gap-x-10 sm:px-8 sm:text-[13px] lg:px-10">
            <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#315FE6]" />Designed for clarity</span>
            <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#0B978F]" />Built around exploration</span>
            <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#8771DB]" />Made for repeatable analysis</span>
          </div>
        </section>

        <section id="why-caas" className="scroll-mt-20 bg-white px-5 py-20 sm:px-8 sm:py-24 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-[1160px]">
            <div className="mx-auto max-w-[710px] text-center">
              <p className="text-[11px] font-bold uppercase tracking-[0.17em] text-[#3864DD]">Why CaaS</p>
              <h2 className="mt-4 text-[clamp(31px,3.5vw,49px)] font-semibold leading-[1.15] tracking-[-0.055em] text-[#19283F]">More understanding. Less complexity.</h2>
              <p className="mt-5 text-[15px] leading-7 text-[#687B93]">Clustering shouldn&apos;t get in the way of curiosity. CaaS makes it easier to move from data to a clearer perspective.</p>
            </div>
            <div className="mt-12 grid gap-5 md:grid-cols-3">
              {benefits.map((benefit) => (
                <article key={benefit.number} className="group rounded-[20px] border border-[#E6EBF2] bg-[#FCFDFE] p-7 transition-all hover:-translate-y-1 hover:border-[#D6E2F6] hover:bg-white hover:shadow-[0_20px_45px_rgba(31,54,89,.07)] sm:p-8">
                  <div className="mb-7 flex items-center justify-between">
                    <span className="flex h-14 w-14 items-center justify-center rounded-[15px] bg-white shadow-[0_4px_16px_rgba(35,56,88,.05)] ring-1 ring-[#E7ECF3]"><BenefitIcon name={benefit.icon} color={benefit.color} /></span>
                    <span className="font-mono text-[11px] font-semibold text-[#A7B2C2]">{benefit.number} / 03</span>
                  </div>
                  <h3 className="text-[20px] font-semibold tracking-[-0.04em] text-[#1B2A43]">{benefit.title}</h3>
                  <p className="mt-3 text-[13px] leading-7 text-[#718199]">{benefit.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-20 border-y border-[#E8EDF4] bg-[#F7F9FC] px-5 py-20 sm:px-8 sm:py-24 lg:px-10 lg:py-28">
          <div className="mx-auto grid max-w-[1160px] items-center gap-11 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.17em] text-[#3864DD]">How it works</p>
              <h2 className="mt-4 max-w-[520px] text-[clamp(32px,3.5vw,48px)] font-semibold leading-[1.16] tracking-[-0.055em] text-[#19283F]">From information to insight. Naturally.</h2>
              <p className="mt-5 max-w-[480px] text-[15px] leading-7 text-[#6C7C94]">A straightforward journey that helps you spend more time understanding the patterns—and less time managing the process.</p>
              <div className="mt-10 space-y-7">
                {journey.map((step) => (
                  <div key={step.number} className="flex items-start gap-5">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#DDE6F8] bg-white font-mono text-[13px] font-bold text-[#4167D4] shadow-[0_4px_12px_rgba(25,48,84,.035)]">{step.number}</span>
                    <div>
                      <h3 className="pt-0.5 text-[17px] font-semibold tracking-[-0.025em] text-[#23314A]">{step.title}</h3>
                      <p className="mt-1.5 max-w-[400px] text-[13px] leading-6 text-[#77869B]">{step.description}</p>
                    </div>
                  </div>
                ))}
              </div>
              <Link href="/register" className="mt-10 inline-flex items-center gap-2 text-[13px] font-bold text-[#315FE6] hover:underline hover:underline-offset-4">Start your first exploration <ArrowIcon /></Link>
            </div>
            <JourneyArtwork />
          </div>
        </section>

        <section className="bg-white px-5 py-20 sm:px-8 sm:py-24 lg:px-10 lg:py-28">
          <div className="relative mx-auto max-w-[1160px] overflow-hidden rounded-[26px] bg-[#182842] px-7 py-14 text-center text-white sm:px-12 sm:py-[72px]">
            <div className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full border border-white/10 bg-[radial-gradient(circle,rgba(67,108,234,.28),transparent_70%)]" />
            <div className="pointer-events-none absolute -bottom-40 -left-16 h-80 w-80 rounded-full border border-white/10 bg-[radial-gradient(circle,rgba(42,186,169,.17),transparent_70%)]" />
            <div className="relative mx-auto max-w-[720px]">
              <p className="text-[11px] font-bold uppercase tracking-[0.17em] text-[#94ADFA]">Your next discovery starts here</p>
              <h2 className="mt-5 text-[clamp(30px,4vw,52px)] font-semibold leading-[1.15] tracking-[-0.055em]">See your data in a whole new way.</h2>
              <p className="mx-auto mt-5 max-w-[540px] text-[14px] leading-7 text-[#B9C8DF] sm:text-[15px]">Bring your questions. Bring your data. Let CaaS help you find the patterns worth exploring.</p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Link href="/register" className="inline-flex min-h-[49px] items-center justify-center gap-2 rounded-lg bg-white px-6 text-[13px] font-bold text-[#1D3665] transition-colors hover:bg-[#E9F0FF]">Create an account <ArrowIcon /></Link>
                <Link href="/login" className="inline-flex min-h-[49px] items-center justify-center rounded-lg border border-white/25 px-6 text-[13px] font-semibold text-white transition-colors hover:bg-white/10">Sign in</Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#E7ECF3] bg-[#FBFCFE]">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-7 px-5 py-9 sm:px-8 md:flex-row md:items-center md:justify-between lg:px-10">
          <div className="flex flex-col gap-2">
            <Link href="/" className="w-fit" aria-label="CaaS home"><BrandMark /></Link>
            <span className="text-[12px] text-[#8695A8]">Clustering with clarity.</span>
          </div>
          <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[12px] font-medium text-[#63758E]">
            <a href="#why-caas" className="hover:text-[#315FE6]">Why CaaS</a>
            <a href="#how-it-works" className="hover:text-[#315FE6]">How it works</a>
            <Link href="/login" className="hover:text-[#315FE6]">Sign in</Link>
            <Link href="/register" className="hover:text-[#315FE6]">Create account</Link>
          </nav>
        </div>
        <div className="border-t border-[#E8EDF4] px-5 py-5 text-center text-[11px] text-[#9AA7B8]">© 2026 CaaS. Built to make data easier to understand.</div>
      </footer>
    </div>
  );
}
