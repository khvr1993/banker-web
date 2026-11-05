import React, { useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';

interface JoinQrProps {
  value: string;
  size?: number;
  className?: string;
  alt?: string;
}

export const JoinQr: React.FC<JoinQrProps> = ({
  value,
  size = 220,
  className = '',
  alt = 'Scan to join the game',
}) => {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc('');
    setFailed(false);
    if (!value) return;

    toDataURL(value, {
      width: Math.max(360, size * 2),
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (failed) {
    return (
      <div className={`join-qr join-qr-fallback ${className}`} style={{ width: size, height: size }}>
        <span>QR unavailable — share the room code instead.</span>
      </div>
    );
  }

  if (!src) {
    return (
      <div
        className={`join-qr join-qr-loading ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }

  return <img className={`join-qr ${className}`} src={src} width={size} height={size} alt={alt} />;
};
