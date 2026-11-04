import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useGame } from '../context/GameContext';
import { formatMoney, derivePlayerColor } from '../lib/constants';
import { localApi } from '../lib/api';
import { StatementRow } from '../types';
import { TransferCard } from './TransferCard';

export const PlayerView: React.FC = () => {
  const {
    game,
    players,
    myPlayerId,
    setMyPlayerId,
    showToast,
    prevBalances,
    setActiveTransferTab,
  } = useGame();

  const [statement, setStatement] = useState<StatementRow[]>([]);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [rentTargetId, setRentTargetId] = useState<string | null>(null);
  const [flashClass, setFlashClass] = useState<string>('');
  const lastBalanceRef = useRef<number | undefined>(undefined);

  const me = useMemo(() => {
    return players.find((p) => p.id === myPlayerId) || null;
  }, [players, myPlayerId]);

  const curr = game?.currency || '₹';

  // Load statement whenever player changes or game refreshes
  const fetchPassbook = async (pid: string) => {
    if (!game) return;
    try {
      setLoadingStatement(true);
      const res = await localApi(`/games/${game.id}/players/${pid}/ledger`);
      const rows: StatementRow[] = res.statement || [];
      rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      setStatement(rows);
    } catch (err: any) {
      console.warn('Passbook load failed:', err);
    } finally {
      setLoadingStatement(false);
    }
  };

  useEffect(() => {
    if (me) {
      fetchPassbook(me.id);
    } else {
      setStatement([]);
    }
  }, [me?.id, game?.current_round, game?.status]);

  // Flash animation for my player cash
  useEffect(() => {
    if (me) {
      const prev = lastBalanceRef.current;
      if (prev !== undefined && prev !== me.cash) {
        setFlashClass(me.cash > prev ? 'flash-credit' : 'flash-debit');
        const timer = setTimeout(() => setFlashClass(''), 1200);
        return () => clearTimeout(timer);
      }
      lastBalanceRef.current = me.cash;
      prevBalances.set(me.id, me.cash);
    }
  }, [me?.cash, me?.id, prevBalances]);

  // If no game is loaded
  if (!game) return null;

  // Screen 4A: Player Picker if not selected
  if (!me) {
    return (
      <section id="view-player" className="view-panel" style={{ display: 'flex' }}>
        <div id="player-picker-screen" className="player-picker-screen" style={{ display: 'block' }}>
          <div className="empty-hero player-picker-hero">
            <div className="hero-icon">👤</div>
            <h2>Who are you at the table?</h2>
            <p className="text-muted">Select your name to manage your wallet and make payments from your phone.</p>
            <div id="player-picker-grid" className="player-picker-grid mt-4">
              {players.length === 0 ? (
                <div className="text-muted text-center p-4">
                  No players seated yet in this game. Ask the Banker to seat you in the lobby!
                </div>
              ) : (
                players.map((p) => {
                  const color = derivePlayerColor(p.seat_no);
                  return (
                    <div key={p.id} className="player-pick-card">
                      <div className="player-pick-left">
                        <div className="player-avatar" style={{ backgroundColor: color.bg, color: color.text }}>
                          {p.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <strong style={{ fontSize: '16px', color: '#fff' }}>{p.name}</strong>
                          <div className="text-xs text-muted">
                            Seat {p.seat_no}
                          </div>
                        </div>
                      </div>
                      <button
                        className="btn btn-primary btn-sm btn-select-player"
                        onClick={() => {
                          setMyPlayerId(p.id);
                          showToast(`Welcome, ${p.name}!`, 'success');
                        }}
                      >
                        Select Me ➔
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Screen 4B: Player Dashboard
  const sorted = [...players].sort((a, b) => b.cash - a.cash);
  const myRank = sorted.findIndex((p) => p.id === me.id) + 1;
  const myColor = derivePlayerColor(me.seat_no);
  const otherPlayers = players.filter((p) => p.id !== me.id);

  const handlePayRentDirect = (targetId: string) => {
    setActiveTransferTab('rent');
    setRentTargetId(targetId);
    const cardEl = document.getElementById('transfer-card');
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => {
        const input = document.getElementById('transfer-amount');
        if (input) input.focus();
      }, 250);
    }
  };

  return (
    <section id="view-player" className="view-panel" style={{ display: 'flex' }}>
      <div id="player-dashboard-screen" className="player-dashboard-screen" style={{ display: 'block' }}>
        {/* Game Lifecycle Notice Banners */}
        {game.status === 'pending' && (
          <div id="player-pending-banner" className="lifecycle-banner banner-pending" style={{ display: 'flex' }}>
            <div className="banner-icon">⏳</div>
            <div>
              <strong>Game Setup in Progress</strong>
              <p className="text-xs">
                Waiting for the Banker to start the game. Starting cash will be distributed when the game begins.
              </p>
            </div>
          </div>
        )}

        {game.status === 'finished' && (
          <div id="player-finished-banner" className="lifecycle-banner banner-finished" style={{ display: 'flex' }}>
            <div className="banner-icon">🏁</div>
            <div>
              <strong>Game Finished & Archived</strong>
              <p className="text-xs">
                The game has concluded. All payments are now closed. Review your final passbook below.
              </p>
            </div>
          </div>
        )}

        {/* Hero Cash Wallet Card */}
        <div className="card player-hero-card" id="player-hero-card">
          <div className="player-hero-header">
            <div className="player-hero-identity">
              <div
                className="player-avatar avatar-lg"
                id="my-player-avatar"
                style={{ backgroundColor: myColor.bg, color: myColor.text }}
              >
                {me.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="hero-name-row">
                  <h2 id="my-player-name" className="my-player-title">
                    {me.name}
                  </h2>
                  <span
                    className={`rank-tag ${myRank <= 3 ? `rank-${myRank}` : ''}`}
                    id="my-player-rank"
                  >
                    #{myRank} Leader
                  </span>
                </div>
                <div className="hero-meta-row">
                  <span id="my-player-seat" className="text-xs text-muted">
                    Seat {me.seat_no}
                  </span>
                  <span className="text-dim">•</span>
                  <span id="my-player-game-round" className="text-xs text-muted">
                    Round {game.current_round || 0}
                  </span>
                </div>
              </div>
            </div>
            <button
              id="btn-switch-my-player"
              className="btn btn-ghost btn-sm"
              title="Change your player identity"
              onClick={() => setMyPlayerId(null)}
            >
              Switch Player
            </button>
          </div>

          <div className={`player-hero-balance-box ${flashClass}`} id="my-player-balance-box">
            <div className="balance-label">Your Available Cash</div>
            <div className="balance-amount-hero" id="my-player-cash">
              {formatMoney(me.cash, curr)}
            </div>
          </div>
        </div>

        {/* Personal Payment Pad */}
        {!me.is_bankrupt && game.status === 'active' && (
          <div id="player-transfer-container" className="mt-4">
            <TransferCard targetPlayerId={rentTargetId} />
          </div>
        )}

        {/* Table Players Overview */}
        <div className="card mt-4 table-roster-card">
          <div className="card-header">
            <h3>Table Players</h3>
            <span className="text-muted text-xs">Tap to send rent directly</span>
          </div>
          <div className="card-body">
            <div id="table-roster-grid" className="table-roster-grid">
              {otherPlayers.length === 0 ? (
                <div className="text-muted text-xs p-2">No other players seated yet.</div>
              ) : (
                otherPlayers.map((p) => {
                  const pColor = derivePlayerColor(p.seat_no);
                  return (
                    <div key={p.id} className="table-roster-item">
                      <div className="table-roster-left">
                        <div
                          className="player-avatar"
                          style={{ backgroundColor: pColor.bg, color: pColor.text }}
                        >
                          {p.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <strong style={{ color: '#fff' }}>{p.name}</strong>
                          <div className="text-xs text-muted">
                            {formatMoney(p.cash, curr)} • Seat {p.seat_no}
                          </div>
                        </div>
                      </div>
                      {!p.is_bankrupt && game.status === 'active' && !me.is_bankrupt && (
                        <button
                          className="btn btn-secondary btn-xs btn-pay-roster"
                          onClick={() => handlePayRentDirect(p.id)}
                        >
                          Pay Rent ➔
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Personal Passbook (Statement) */}
        <div className="card mt-4 passbook-card">
          <div className="card-header">
            <div className="heading-with-badge">
              <h3>My Passbook</h3>
              <span className="badge badge-info" id="passbook-count-badge">
                {statement.length} entries
              </span>
            </div>
            <button
              id="btn-refresh-passbook"
              className="btn btn-ghost btn-xs"
              title="Refresh statement"
              onClick={() => fetchPassbook(me.id)}
            >
              🔄 Refresh
            </button>
          </div>
          <div className="card-body no-padding">
            <div className="table-container">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th style={{ width: '80px' }}>Time</th>
                    <th style={{ width: '60px' }}>Round</th>
                    <th style={{ width: '130px' }}>Category</th>
                    <th>Counterparty</th>
                    <th style={{ textAlign: 'right', width: '110px' }}>Debit (Out)</th>
                    <th style={{ textAlign: 'right', width: '110px' }}>Credit (In)</th>
                    <th>Memo</th>
                  </tr>
                </thead>
                <tbody id="player-passbook-tbody">
                  {loadingStatement ? (
                    <tr>
                      <td colSpan={7} className="text-center text-muted p-4">
                        Loading passbook...
                      </td>
                    </tr>
                  ) : statement.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center text-muted p-4">
                        No transactions recorded yet in your passbook.
                      </td>
                    </tr>
                  ) : (
                    statement.map((r) => {
                      const timeStr = r.created_at ? r.created_at.split('T')[1]?.substring(0, 8) : '';
                      const counterpartyName =
                        r.counterparty === 'BANK'
                          ? '🏛️ Bank'
                          : players.find((p) => p.id === r.counterparty)?.name || r.counterparty || '-';
                      return (
                        <tr key={r.txn_id} className={r.voided ? 'is-voided' : ''}>
                          <td className="text-xs text-muted">{timeStr}</td>
                          <td>
                            <span className="badge badge-info">R{r.round}</span>
                          </td>
                          <td>
                            <span className={`category-tag cat-${r.account_category}`}>
                              {r.account_category}
                            </span>
                          </td>
                          <td>
                            <span className="counterparty-pill">{counterpartyName}</span>
                          </td>
                          <td style={{ textAlign: 'right' }} className={r.dr > 0 ? 'amount-dr' : 'text-dim'}>
                            {r.dr > 0 ? formatMoney(r.dr, curr) : '-'}
                          </td>
                          <td style={{ textAlign: 'right' }} className={r.cr > 0 ? 'amount-cr' : 'text-dim'}>
                            {r.cr > 0 ? formatMoney(r.cr, curr) : '-'}
                          </td>
                          <td className="text-xs text-muted">{r.description || '-'}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
