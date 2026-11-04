import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useGame } from '../context/GameContext';
import { formatMoney } from '../lib/constants';
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

  if (!game) return null;

  // Screen 4A: Player Picker if not selected
  if (!me) {
    return (
      <section id="view-player" className="view-panel">
        <div id="player-picker-screen" className="player-picker-screen">
          <div className="empty-hero player-picker-hero">
            <div className="hero-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <h2>Select Your Player Seat</h2>
            <p className="text-muted">Choose your identity at the table to view your wallet balance and issue direct transfers.</p>
            <div id="player-picker-grid" className="player-picker-grid mt-3">
              {players.length === 0 ? (
                <div className="text-muted text-center p-4">
                  No players seated yet in this session. Ask the Banker to seat you in the lobby.
                </div>
              ) : (
                players.map((p) => (
                  <div key={p.id} className="player-pick-card">
                    <div className="player-pick-left">
                      <div>
                        <strong>{p.name}</strong>
                        <div className="text-xs text-muted">Seat {p.seat_no}</div>
                      </div>
                    </div>
                    <button
                      className="btn btn-primary btn-sm btn-select-player"
                      onClick={() => {
                        setMyPlayerId(p.id);
                        showToast(`Welcome, ${p.name}!`, 'success');
                      }}
                    >
                      Select Seat →
                    </button>
                  </div>
                ))
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
  const otherPlayers = players.filter((p) => p.id !== me.id);

  const handlePayRentDirect = (targetId: string) => {
    setActiveTransferTab('custom');
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
    <section id="view-player" className="view-panel">
      <div id="player-dashboard-screen" className="player-dashboard-screen">
        {/* Game Lifecycle Notice Banners */}
        {game.status === 'pending' && (
          <div id="player-pending-banner" className="lifecycle-banner banner-pending">
            <div>
              <strong>Session Setup in Progress</strong>
              <p className="text-xs text-muted">
                Waiting for the Banker to start the session. Starting cash will be distributed when the game begins.
              </p>
            </div>
          </div>
        )}

        {game.status === 'finished' && (
          <div id="player-finished-banner" className="lifecycle-banner banner-finished">
            <div>
              <strong>Session Archived</strong>
              <p className="text-xs text-muted">
                The game has concluded. All payments are closed. Review your final passbook below.
              </p>
            </div>
          </div>
        )}

        {/* Hero Cash Wallet Card */}
        <div className="card player-hero-card" id="player-hero-card">
          <div className="player-hero-header">
            <div className="player-hero-identity">
              <div>
                <div className="hero-name-row">
                  <h2 id="my-player-name" className="my-player-title">
                    {me.name}
                  </h2>
                </div>
                <div className="hero-meta-row">
                  <span id="my-player-rank" className="mono-num">Rank #{myRank}</span>
                  <span className="text-dim" aria-hidden="true">·</span>
                  <span id="my-player-seat">Seat {me.seat_no}</span>
                  <span className="text-dim" aria-hidden="true">·</span>
                  <span id="my-player-game-round" className="mono-num">Round {game.current_round || 0}</span>
                </div>
              </div>
            </div>
            <button
              id="btn-switch-my-player"
              className="btn btn-secondary btn-sm"
              title="Change your player identity"
              onClick={() => setMyPlayerId(null)}
            >
              Switch Player
            </button>
          </div>

          <div className={`player-hero-balance-box ${flashClass}`} id="my-player-balance-box">
            <div className="balance-label">Available Cash Balance</div>
            <div className="balance-amount-hero mono-num" id="my-player-cash">
              {formatMoney(me.cash, curr)}
            </div>
          </div>
        </div>

        {/* Personal Payment Pad */}
        {!me.is_bankrupt && game.status === 'active' && (
          <div id="player-transfer-container">
            <TransferCard targetPlayerId={rentTargetId} />
          </div>
        )}

        {/* Table Players Overview */}
        <div className="card table-roster-card">
          <div className="card-header">
            <h3>Table Players</h3>
            <span className="text-muted text-xs">Quick rent transfer</span>
          </div>
          <div className="card-body">
            <div id="table-roster-grid" className="table-roster-grid">
              {otherPlayers.length === 0 ? (
                <div className="text-muted text-xs p-2">No other players seated yet.</div>
              ) : (
                otherPlayers.map((p) => (
                  <div key={p.id} className="table-roster-item">
                    <div className="table-roster-left">
                      <div>
                        <strong>{p.name}</strong>
                        <div className="text-xs text-muted mono-num">
                          {formatMoney(p.cash, curr)} · Seat {p.seat_no}
                        </div>
                      </div>
                    </div>
                    {!p.is_bankrupt && game.status === 'active' && !me.is_bankrupt && (
                      <button
                        className="btn btn-secondary btn-xs btn-pay-roster"
                        onClick={() => handlePayRentDirect(p.id)}
                      >
                        Pay Rent →
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Personal Passbook (Statement) */}
        <div className="card passbook-card">
          <div className="card-header">
            <div className="heading-with-badge">
              <h3>Passbook Statement</h3>
              <span className="meta-inline mono-num" id="passbook-count-badge">
                {statement.length} entries
              </span>
            </div>
            <button
              id="btn-refresh-passbook"
              className="btn btn-ghost btn-xs"
              title="Refresh statement"
              onClick={() => fetchPassbook(me.id)}
            >
              Refresh
            </button>
          </div>
          <div className="card-body no-padding">
            <div className="table-container">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th style={{ width: '90px' }}>Time</th>
                    <th style={{ width: '65px' }}>Round</th>
                    <th style={{ width: '150px' }}>Category</th>
                    <th>Counterparty</th>
                    <th style={{ textAlign: 'right', width: '120px' }}>Debit (Out)</th>
                    <th style={{ textAlign: 'right', width: '120px' }}>Credit (In)</th>
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
                          ? 'Bank Reserve'
                          : players.find((p) => p.id === r.counterparty)?.name || r.counterparty || '-';
                      return (
                        <tr key={r.txn_id} className={r.voided ? 'is-voided' : ''}>
                          <td className="text-xs text-muted mono-num">{timeStr}</td>
                          <td className="mono-num text-muted">R{r.round}</td>
                          <td>
                            <span className="category-text mono-num">{r.account_category}</span>
                          </td>
                          <td>
                            <span className="counterparty-text">{counterpartyName}</span>
                          </td>
                          <td style={{ textAlign: 'right' }} className={`mono-num ${r.dr > 0 ? 'amount-dr' : 'text-dim'}`}>
                            {r.dr > 0 ? formatMoney(r.dr, curr) : '-'}
                          </td>
                          <td style={{ textAlign: 'right' }} className={`mono-num ${r.cr > 0 ? 'amount-cr' : 'text-dim'}`}>
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
