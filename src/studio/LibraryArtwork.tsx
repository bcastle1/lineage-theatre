const artwork = {
  left: ["heirloom", "roots"],
  right: ["homecoming", "gathering"],
} as const;

/** Illustrative film stills, separate from the customer's saved films. */
export default function LibraryArtwork({ side }: { side: keyof typeof artwork }) {
  return <div className={`library-artwork library-artwork-${side}`} aria-hidden="true">
    {artwork[side].map((name, index) => <div className="library-artwork-frame" key={name}>
      <img
        src={`/assets/library-${name}.webp`}
        srcSet={`/assets/library-${name}-small.webp 360w, /assets/library-${name}.webp 840w`}
        sizes="(max-width: 700px) 24vw, (max-width: 1279px) 20vw, 280px"
        width="840"
        height="1120"
        alt=""
        loading={index === 0 ? "eager" : "lazy"}
        decoding="async"
        draggable={false}
      />
    </div>)}
  </div>;
}
