"use client";

import { useState } from "react";

const clusters = [
  {
    id: "a",
    label: "Segment 01",
    color: "#4367D8",
    description: "Lower-frequency customers",
    points: [
      [102, 235], [121, 214], [139, 247], [151, 221],
      [162, 259], [177, 230], [193, 207], [207, 250],
      [223, 226], [238, 246], [186, 272], [147, 276],
    ],
  },
  {
    id: "b",
    label: "Segment 02",
    color: "#159A86",
    description: "Consistent, engaged customers",
    points: [
      [280, 158], [297, 177], [315, 143], [328, 163],
      [344, 132], [360, 170], [376, 142], [391, 182],
      [407, 151], [425, 171], [353, 196], [383, 115],
    ],
  },
  {
    id: "c",
    label: "Segment 03",
    color: "#D69B48",
    description: "High-value regular customers",
    points: [
      [430, 95], [447, 119], [462, 83], [475, 109],
      [488, 68], [505, 98], [518, 73], [533, 116],
      [547, 89], [558, 62], [482, 137], [522, 133],
    ],
  },
] as const;

type ClusterFilter = "all" | (typeof clusters)[number]["id"];

const steps = [
  {
    number: "01",
    title: "Bring your dataset",
    description:
      "Upload a CSV, inspect its columns, and understand the data before you run anything.",
  },
  {
    number: "02",
    title: "Choose the experiment",
    description:
      "Select your features and clustering settings, then submit a reproducible run.",
  },
  {
    number: "03",
    title: "Explore the structure",
    description:
      "Review cluster sizes, centroids, metrics, and individual assignments in one place.",
  },
];

export default function Home() {
  const [selected, setSelected] = useState<ClusterFilter>("all");
  const currentCluster = clusters.find(
    (cluster) => cluster.id === selected
  );

  return (
    <div className="min-h-screen bg-[#F7F8FA] font-sans text-[#172235] antialiased">
      {/* Navigation */}
      <div className="border-b border-[#E7EAF0] bg-white/95">
        <header className="mx-auto flex h-[76px] max-w-[1240px] items-center justify-between px-5 sm:px-8">
          <a
            href="#top"
            className="flex items-center gap-3"
            aria-label="CaaS home"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[#172235]">
              <span className="relative block h-4 w-4">
                <span className="absolute left-0 top-0 h-[6px] w-[6px] rounded-[2px] bg-white" />
                <span className="absolute right-0 top-[3px] h-[6px] w-[6px] rounded-[2px] bg-[#8CA4FF]" />
                <span className="absolute bottom-0 left-[4px] h-[6px] w-[6px] rounded-[2px] bg-[#65D8BD]" />
              </span>
            </span>

            <span className="text-[19px] font-semibold tracking-[-0.04em]">
              caas<span className="text-[#5263A3]">.</span>
            </span>

            <span className="ml-1 hidden border-l border-[#DBDFE7] pl-4 text-[12px] font-medium tracking-[0.01em] text-[#7B8495] sm:block">
              Clustering workspace
            </span>
          </a>

          <nav
            className="hidden items-center gap-8 text-[13px] font-medium text-[#6B7585] md:flex"
            aria-label="Main navigation"
          >
            <a
              href="#workspace"
              className="transition-colors hover:text-[#172235]"
            >
              Product
            </a>
            <a
              href="#workflow"
              className="transition-colors hover:text-[#172235]"
            >
              How it works
            </a>
          </nav>

          <a
            href="#workspace"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#DDE1E8] bg-white px-4 text-[12px] font-semibold text-[#253149] shadow-[0_1px_2px_rgba(21,34,54,0.03)] transition-colors hover:bg-[#F7F8FA] sm:text-[13px]"
          >
            View workspace <span aria-hidden="true">↗</span>
          </a>
        </header>
      </div>

      <main id="top">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-[#E8EBF0]">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.35]"
            style={{
              backgroundImage:
                "linear-gradient(#DCE2ED 1px, transparent 1px), linear-gradient(90deg, #DCE2ED 1px, transparent 1px)",
              backgroundSize: "64px 64px",
              maskImage:
                "linear-gradient(to bottom, transparent, black 60%, transparent)",
            }}
          />

          <div className="relative mx-auto max-w-[1240px] px-5 pb-14 pt-20 sm:px-8 sm:pb-20 sm:pt-24 lg:pt-28">
            <div className="mx-auto max-w-[780px] text-center">
              <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#DCE3F5] bg-white px-3 py-[7px] text-[11px] font-semibold tracking-[0.08em] text-[#455D9E] uppercase shadow-[0_2px_10px_rgba(27,47,86,0.03)]">
                <span className="h-[6px] w-[6px] rounded-full bg-[#476BE0]" />
                A clearer way to explore your data
              </div>

              <h1 className="text-[43px] leading-[1.1] font-semibold tracking-[-0.065em] text-[#152238] sm:text-[62px] lg:text-[72px]">
                Find structure in your data.
                <span className="block text-[#6E7D98]">
                  Understand every cluster.
                </span>
              </h1>

              <p className="mx-auto mt-6 max-w-[590px] text-[15px] leading-7 text-[#647188] sm:text-[17px]">
                From raw CSVs to meaningful segments. Configure
                K-Means, track your experiments, and explore results
                without losing sight of the details.
              </p>

              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <a
                  href="#workspace"
                  className="inline-flex h-12 items-center gap-3 rounded-[10px] bg-[#305BE8] px-6 text-[13px] font-semibold text-white shadow-[0_6px_16px_rgba(48,91,232,0.18)] transition-all hover:-translate-y-[1px] hover:bg-[#244CD6]"
                >
                  Explore the workspace
                  <span aria-hidden="true">↗</span>
                </a>

                <a
                  href="#workflow"
                  className="inline-flex h-12 items-center rounded-[10px] border border-[#DCE1E8] bg-white px-6 text-[13px] font-semibold text-[#2D3950] transition-colors hover:bg-[#F0F3F8]"
                >
                  See how it works
                </a>
              </div>

              <p className="mt-6 text-[11px] tracking-[0.01em] text-[#93A0B2]">
                Built for transparent, repeatable clustering workflows.
              </p>
            </div>
          </div>
        </section>

        {/* Interactive workspace preview */}
        <section
          id="workspace"
          className="mx-auto max-w-[1240px] px-5 pb-20 pt-14 sm:px-8 sm:pb-24 sm:pt-20"
        >
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 text-[11px] font-semibold tracking-[0.15em] text-[#5370C9] uppercase">
                The workspace
              </p>

              <h2 className="text-[26px] font-semibold tracking-[-0.045em] sm:text-[34px]">
                A home for your experiments.
              </h2>

              <p className="mt-2 text-[13px] text-[#718096]">
                Thoughtful controls. Clear analysis. No unnecessary noise.
              </p>
            </div>

            <span className="rounded-md border border-[#DCE2EA] bg-white px-3 py-2 font-mono text-[10px] text-[#7E899B]">
              INTERACTIVE INTERFACE PREVIEW
            </span>
          </div>

          <div className="overflow-hidden rounded-[15px] border border-[#DCE1E9] bg-white shadow-[0_24px_70px_rgba(25,40,65,0.09)]">
            {/* App preview top bar */}
            <div className="flex h-[42px] items-center gap-2 border-b border-[#E8EBF0] bg-[#FCFCFD] px-5">
              <span className="h-[8px] w-[8px] rounded-full bg-[#EB8080]" />
              <span className="h-[8px] w-[8px] rounded-full bg-[#E8BD66]" />
              <span className="h-[8px] w-[8px] rounded-full bg-[#77B99E]" />

              <span className="ml-auto font-mono text-[10px] text-[#9AA4B2]">
                app.caas / experiment-preview
              </span>
            </div>

            <div className="flex min-h-[570px]">
              {/* Sidebar preview */}
              <aside
                className="hidden w-[204px] shrink-0 flex-col bg-[#192437] px-4 py-6 text-white md:flex"
                aria-label="Preview navigation"
              >
                <div className="flex items-center gap-2 px-3 text-[13px] font-semibold tracking-[-0.02em]">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#617FE6] text-[12px]">
                    ◈
                  </span>
                  caas workspace
                </div>

                <p className="mb-4 mt-10 px-3 text-[9px] font-semibold tracking-[0.14em] text-[#75849C] uppercase">
                  Workspace
                </p>

                {[
                  { number: "01", title: "Overview" },
                  { number: "02", title: "Datasets" },
                  { number: "03", title: "Experiments" },
                  { number: "04", title: "Results" },
                ].map((item) => (
                  <div
                    key={item.number}
                    className={`mb-1 flex h-10 items-center gap-3 rounded-[7px] px-3 text-[12px] ${
                      item.title === "Results"
                        ? "bg-[#31435E] font-semibold text-white"
                        : "text-[#9DAAC0]"
                    }`}
                  >
                    <span className="font-mono text-[10px] text-[#8697AF]">
                      {item.number}
                    </span>

                    {item.title}

                    {item.title === "Results" && (
                      <span className="ml-auto text-[#AFC3FF]">
                        •
                      </span>
                    )}
                  </div>
                ))}

                <div className="mt-auto rounded-lg border border-[#34435A] bg-[#212F44] p-3">
                  <p className="text-[11px] font-medium text-[#E5EBF5]">
                    Your analysis, organized.
                  </p>

                  <p className="mt-2 text-[10px] leading-5 text-[#91A0B6]">
                    Every dataset and experiment in one workspace.
                  </p>
                </div>
              </aside>

              {/* Workspace content */}
              <div className="min-w-0 flex-1 bg-[#FBFCFE]">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#EAEDF2] bg-white px-5 py-4 sm:px-7">
                  <span className="text-[11px] text-[#8994A5]">
                    Experiments
                    <span className="mx-2">/</span>
                    <span className="font-medium text-[#344259]">
                      Customer segmentation
                    </span>
                  </span>

                  <span className="inline-flex items-center gap-2 rounded-md bg-[#EDF7F4] px-2.5 py-1.5 text-[10px] font-semibold text-[#28816C]">
                    <span className="h-[6px] w-[6px] rounded-full bg-[#36A188]" />
                    Example run · completed
                  </span>
                </div>

                <div className="px-5 py-6 sm:px-7 sm:py-7">
                  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-semibold tracking-[0.12em] text-[#8A96A8] uppercase">
                        Experiment / Sample 001
                      </p>

                      <h3 className="mt-1.5 text-[23px] font-semibold tracking-[-0.04em] text-[#1E2C41]">
                        Customer segmentation
                      </h3>

                      <p className="mt-1 text-[11px] text-[#8591A3]">
                        Demonstration dataset · K-Means clustering
                      </p>
                    </div>

                    <span className="rounded-md border border-[#E0E6EF] bg-white px-3 py-2 text-[10px] font-medium text-[#69768C]">
                      3 clusters · 2 features
                    </span>
                  </div>

                  {/* Summary metrics */}
                  <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {[
                      {
                        label: "Preview points",
                        value: "36",
                        extra: "Sample observations",
                      },
                      {
                        label: "Segments",
                        value: "03",
                        extra: "Identified groups",
                      },
                      {
                        label: "Input features",
                        value: "02",
                        extra: "Selected columns",
                      },
                      {
                        label: "Run state",
                        value: "Done",
                        extra: "Illustrative result",
                      },
                    ].map((metric) => (
                      <div
                        key={metric.label}
                        className="rounded-lg border border-[#E5E9EF] bg-white px-4 py-3"
                      >
                        <p className="text-[10px] font-medium text-[#8B97A7]">
                          {metric.label}
                        </p>

                        <p className="mt-1 text-[23px] leading-tight font-semibold tracking-[-0.045em] text-[#253248]">
                          {metric.value}
                        </p>

                        <p className="mt-1.5 text-[9px] text-[#A0AAB9]">
                          {metric.extra}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_215px]">
                    {/* Scatter plot */}
                    <div className="min-w-0 rounded-lg border border-[#E5E9EF] bg-white p-4 sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h4 className="text-[13px] font-semibold text-[#29374B]">
                            Cluster distribution
                          </h4>

                          <p className="mt-1 text-[10px] text-[#94A0B1]">
                            Illustrative scatter plot · 36 preview points
                          </p>
                        </div>

                        <span className="rounded border border-[#E5E9F0] px-2 py-1 font-mono text-[9px] text-[#8996A7]">
                          2D VIEW
                        </span>
                      </div>

                      <div className="mt-4 overflow-hidden rounded-md border border-[#EFF1F5] bg-[#FCFDFE]">
                        <svg
                          viewBox="0 0 640 310"
                          role="img"
                          aria-label="Interactive sample scatter plot of three customer clusters"
                          className="h-auto w-full"
                        >
                          {[50, 105, 160, 215, 270].map((y) => (
                            <line
                              key={`h-${y}`}
                              x1="58"
                              x2="610"
                              y1={y}
                              y2={y}
                              stroke="#E7EBF2"
                              strokeDasharray="3 6"
                            />
                          ))}

                          {[90, 190, 290, 390, 490, 590].map((x) => (
                            <line
                              key={`v-${x}`}
                              x1={x}
                              x2={x}
                              y1="35"
                              y2="275"
                              stroke="#E7EBF2"
                              strokeDasharray="3 6"
                            />
                          ))}

                          <line
                            x1="58"
                            x2="610"
                            y1="275"
                            y2="275"
                            stroke="#CBD3DF"
                          />

                          <line
                            x1="58"
                            x2="58"
                            y1="35"
                            y2="275"
                            stroke="#CBD3DF"
                          />

                          <text
                            x="338"
                            y="303"
                            fill="#91A0B1"
                            fontSize="11"
                            textAnchor="middle"
                          >
                            Visit frequency →
                          </text>

                          <text
                            x="20"
                            y="160"
                            fill="#91A0B1"
                            fontSize="11"
                            textAnchor="middle"
                            transform="rotate(-90 20 160)"
                          >
                            Annual spending →
                          </text>

                          {clusters.map((cluster) =>
                            cluster.points.map(([x, y], index) => (
                              <circle
                                key={`${cluster.id}-${index}`}
                                cx={x}
                                cy={y}
                                r={
                                  selected === cluster.id
                                    ? 7
                                    : 5.5
                                }
                                fill={cluster.color}
                                fillOpacity={
                                  selected === "all" ||
                                  selected === cluster.id
                                    ? 0.84
                                    : 0.13
                                }
                                stroke="#FFFFFF"
                                strokeWidth="1.5"
                              />
                            ))
                          )}
                        </svg>
                      </div>

                      {/* Interactive cluster selection */}
                      <div
                        className="mt-4 flex flex-wrap items-center gap-2"
                        role="group"
                        aria-label="Highlight cluster"
                      >
                        <button
                          type="button"
                          aria-pressed={selected === "all"}
                          onClick={() => setSelected("all")}
                          className={`rounded-md border px-3 py-1.5 text-[10px] font-semibold transition-colors ${
                            selected === "all"
                              ? "border-[#BBC8EF] bg-[#EEF2FF] text-[#3F5EBB]"
                              : "border-[#E3E7EE] text-[#7A8698] hover:bg-[#F5F7FA]"
                          }`}
                        >
                          All clusters
                        </button>

                        {clusters.map((cluster) => (
                          <button
                            key={cluster.id}
                            type="button"
                            aria-pressed={selected === cluster.id}
                            onClick={() =>
                              setSelected(cluster.id)
                            }
                            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
                              selected === cluster.id
                                ? "border-[#BBC8EF] bg-[#EEF2FF] text-[#334E9D]"
                                : "border-[#E3E7EE] text-[#7A8698] hover:bg-[#F5F7FA]"
                            }`}
                          >
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{
                                backgroundColor: cluster.color,
                              }}
                            />

                            {cluster.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Cluster insight panel */}
                    <div className="rounded-lg border border-[#E5E9EF] bg-white p-4 sm:p-5">
                      <p className="text-[10px] font-semibold tracking-[0.11em] text-[#9AA6B6] uppercase">
                        Cluster insight
                      </p>

                      <p className="mt-2 text-[17px] font-semibold tracking-[-0.03em] text-[#233248]">
                        {currentCluster?.label ?? "All segments"}
                      </p>

                      <p className="mt-2 min-h-12 text-[11px] leading-5 text-[#8190A3]">
                        {currentCluster?.description ??
                          "Select a cluster below the chart to focus on its observations."}
                      </p>

                      <div className="my-5 h-px bg-[#E9EDF3]" />

                      <p className="mb-3 text-[10px] font-semibold text-[#4B5A70]">
                        Group breakdown
                      </p>

                      <div className="space-y-3">
                        {clusters.map((cluster) => (
                          <div
                            key={cluster.id}
                            className={
                              selected !== "all" &&
                              selected !== cluster.id
                                ? "opacity-35"
                                : ""
                            }
                          >
                            <div className="mb-1.5 flex justify-between text-[10px]">
                              <span className="text-[#6D7A8E]">
                                {cluster.label}
                              </span>

                              <span className="font-semibold text-[#33425A]">
                                12
                              </span>
                            </div>

                            <div className="h-[5px] overflow-hidden rounded-full bg-[#EFF2F6]">
                              <div
                                className="h-full w-full rounded-full"
                                style={{
                                  backgroundColor: cluster.color,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-7 rounded-md bg-[#F4F6FA] p-3">
                        <p className="text-[10px] font-medium text-[#526176]">
                          Preview only
                        </p>

                        <p className="mt-1 text-[10px] leading-5 text-[#91A0B1]">
                          These points are sample data, not results
                          from your account.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="mt-4 text-center text-[11px] text-[#9AA5B4]">
            This is an interactive design preview. Real datasets
            and live experiments will be connected in the next stages.
          </p>
        </section>

        {/* Workflow section */}
        <section
          id="workflow"
          className="border-t border-[#E5E9EF] bg-white py-20 sm:py-24"
        >
          <div className="mx-auto max-w-[1240px] px-5 sm:px-8">
            <div className="max-w-[600px]">
              <p className="mb-3 text-[11px] font-semibold tracking-[0.15em] text-[#5370C9] uppercase">
                Simple by design
              </p>

              <h2 className="text-[29px] leading-tight font-semibold tracking-[-0.05em] text-[#172235] sm:text-[40px]">
                From data to direction.
              </h2>

              <p className="mt-3 text-[14px] leading-7 text-[#78869A]">
                A focused workflow that keeps your experiment
                understandable at every step.
              </p>
            </div>

            <div className="mt-11 grid gap-4 md:grid-cols-3">
              {steps.map((step) => (
                <div
                  key={step.number}
                  className="rounded-xl border border-[#E7EAF0] bg-[#FAFBFC] p-6 sm:p-7"
                >
                  <span className="font-mono text-[11px] font-semibold text-[#6378AC]">
                    {step.number} / 03
                  </span>

                  <h3 className="mt-8 text-[17px] font-semibold tracking-[-0.03em] text-[#253248]">
                    {step.title}
                  </h3>

                  <p className="mt-3 text-[12px] leading-6 text-[#8290A2]">
                    {step.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#E7EAF0] bg-white">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-5 py-6 sm:px-8">
          <span className="text-[13px] font-semibold tracking-[-0.03em] text-[#253248]">
            caas.
          </span>

          <span className="text-[11px] text-[#98A3B1]">
            Clustering, with clarity. © 2026 CaaS.
          </span>
        </div>
      </footer>
    </div>
  );
}
