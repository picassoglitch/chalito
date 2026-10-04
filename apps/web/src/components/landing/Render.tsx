import type { ShowcaseAsset } from "@/lib/showcase";
import type { AppLocale } from "@/i18n/routing";

/**
 * A real render. Animated ones fall back to their poster under prefers-reduced-motion (a media
 * query on <source>: no script). Only the hero loads eagerly.
 */
export const Render = ({
  asset,
  locale,
  eager = false,
  className = "",
}: {
  asset: ShowcaseAsset;
  locale: AppLocale;
  eager?: boolean;
  className?: string;
}) => (
  <picture>
    {asset.poster ? <source media="(prefers-reduced-motion: reduce)" srcSet={asset.poster} type="image/webp" /> : null}
    <img
      src={asset.src}
      width={asset.w}
      height={asset.h}
      alt={asset.alt[locale]}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : "auto"}
      decoding="async"
      data-showcase={asset.id}
      className={`h-auto w-full ${className}`}
    />
  </picture>
);
