import { useRef, useState, type ReactNode } from "react";
import {
  Aperture, ArrowRight, Clapperboard, Download, Files, Film,
  Images, Loader2, Play, Sparkles,
} from "lucide-react";
import "./landing.css";

const chapters = [
  { icon: Files, title: "Gather the memories", text: "Begin with photographs, letters, records, or a story someone in your family remembers." },
  { icon: Sparkles, title: "Find your story", text: "Explore story directions, choose your themes, and shape a documentary or cinematic treatment." },
  { icon: Clapperboard, title: "Make it your own", text: "Arrange scenes, refine the words, and bring your photographs, footage, and narration together." },
  { icon: Download, title: "Keep the film", text: "Create and download a film to watch together, share with family, and pass on." },
];

export default function Landing({ children }: { children: ReactNode }) {
  const video = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState("");
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);

  async function playSample() {
    const player = video.current;
    if (!player) return;
    document.getElementById("sample-film")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    player.focus({ preventScroll: true });
    setVideoError("");
    setBuffering(true);
    try {
      await player.play();
    } catch {
      setBuffering(false);
      setVideoError("Playback could not start. Use the video controls to try again, or open the sample below.");
    }
  }

  return (
    <div className="landing">
      <a className="landing-skip" href="#studio">Skip to sign in</a>
      <header className="landing-header">
        <a className="landing-brand" href="#home" aria-label="Lineage Theatre home">
          <Aperture size={30} aria-hidden="true" />
          <span>Lineage Theatre</span>
        </a>
        <nav aria-label="Main navigation">
          <a className="landing-nav-link" href="#sample-film">The sample film</a>
          <a className="landing-nav-link" href="#how-it-works">How it works</a>
          <a className="landing-button header-signin" href="#studio">Sign in <ArrowRight size={16} aria-hidden="true" /></a>
        </nav>
      </header>

      <main id="home">
        <section className="cinema-hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="landing-eyebrow"><Film size={16} aria-hidden="true" /> A family-history film studio</p>
            <h1 id="hero-title">Their story.<br />Your family’s<br /><em>next great film.</em></h1>
            <p className="hero-description">Bring the people behind your family history into focus. Turn photographs, records, and memories into a film that carries their story forward.</p>
            <div className="hero-actions">
              <a className="landing-button light" href="#studio">Enter your studio <ArrowRight size={18} aria-hidden="true" /></a>
              <button className="landing-play-link" type="button" onClick={() => void playSample()}><Play size={17} aria-hidden="true" /> Watch the sample</button>
            </div>
            <p className="hero-footnote">Your memories. Your direction. Something to keep.</p>
          </div>
          <figure className="hero-still">
            <img src="/assets/ancestor-shipyard-still.png" width="1672" height="941" decoding="async" alt="Cinematic illustration of an ancestor standing beside a wooden ship in a sunlit historic shipyard" />
            <figcaption><span>A life remembered. A story reimagined.</span><span>Illustrative cinematic scene</span></figcaption>
          </figure>
        </section>

        <div className="landing-capabilities" aria-label="Studio features">
          <span><Images size={20} aria-hidden="true" /> Start with your family archive</span>
          <span><Sparkles size={20} aria-hidden="true" /> Shape the story with AI</span>
          <span><Film size={20} aria-hidden="true" /> Create a film worth keeping</span>
        </div>

        <section id="sample-film" className="sample-section landing-section" aria-labelledby="sample-title">
          <div className="sample-copy">
            <p className="landing-eyebrow">A glimpse of what’s possible</p>
            <h2 id="sample-title">One journey.<br />Generations of meaning.</h2>
            <p>A departure. A new beginning. A life that becomes part of a family’s story. Watch <em>The Journey of Thomas Wilson</em>, our original cinematic sample.</p>
            <button className="landing-button forest" type="button" onClick={() => void playSample()} disabled={buffering || playing}>
              {buffering ? <Loader2 size={17} className="spin" aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
              {buffering ? "Loading the film…" : playing ? "Trailer playing" : "Play sample trailer"}
            </button>
            <span className="sample-runtime">1 min 18 sec · Full HD · Sound on</span>
          </div>
          <figure className="sample-player">
            <div className="sample-screen">
              <video
                ref={video}
                controls
                playsInline
                preload="none"
                tabIndex={0}
                width="1920"
                height="1080"
                poster="/assets/the-journey-of-thomas-wilson-poster.jpg"
                src="/assets/the-journey-of-thomas-wilson.mp4"
                aria-label="The Journey of Thomas Wilson — sample trailer"
                aria-describedby="sample-caption"
                onWaiting={() => setBuffering(true)}
                onPlaying={() => { setBuffering(false); setPlaying(true); setVideoError(""); }}
                onPause={() => { setPlaying(false); setBuffering(false); }}
                onEnded={() => { setPlaying(false); setBuffering(false); }}
                onError={() => { setPlaying(false); setBuffering(false); setVideoError("The sample could not load. Please try opening the film directly below."); }}
              >
                Your browser does not support this video. <a href="/assets/the-journey-of-thomas-wilson.mp4">Open the sample film</a>.
              </video>
            </div>
            <figcaption id="sample-caption">
              <div><span>The Journey of Thomas Wilson</span><small>Illustrative sample · Dramatized scenes</small></div>
              <a href="/assets/the-journey-of-thomas-wilson.mp4" target="_blank" rel="noreferrer">Open film <ArrowRight size={15} aria-hidden="true" /></a>
            </figcaption>
            {videoError && <p className="sample-error" role="alert">{videoError}</p>}
          </figure>
        </section>

        <section id="how-it-works" className="story-section landing-section" aria-labelledby="story-title">
          <div className="story-heading"><p className="landing-eyebrow">From the archive to the screen</p><h2 id="story-title">Start with a memory.<br />Give it a life on screen.</h2></div>
          <ol className="story-chapters">
            {chapters.map(({ icon: Icon, title, text }, i) => <li key={title}>
              <div className="chapter-top"><Icon size={27} aria-hidden="true" /><span>0{i + 1}</span></div>
              <h3>{title}</h3><p>{text}</p>
            </li>)}
          </ol>
        </section>
        {children}
      </main>
      <footer className="landing-footer">
        <a className="landing-brand" href="#home"><Aperture size={24} aria-hidden="true" /><span>Lineage Theatre</span></a>
        <p>Stories across generations.</p>
        <nav aria-label="Legal"><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a><a href="/security.html">Security</a></nav>
      </footer>
    </div>
  );
}
