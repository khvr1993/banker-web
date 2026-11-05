import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useGame } from '../context/GameContext';
import { formatMoney } from '../lib/constants';
import { downloadGameCsv } from '../lib/api';
import { gameApi } from '../lib/gameApi';
import { TransferCard } from './TransferCard';
import { HostSessionPanel } from './HostSessionPanel';

export const BankerConsoleView: React.FC = () => {
  const {
    game,
    players,
    transactions,
    prevBalances,
    openModal,
    showToast,
    refreshActiveGame,
    sessionRole,
    remotePeers,
  } = useGame();

  const [activeTab, setActiveTab] = useState<'console' | 'ledger' | 'session'>('console');

  // Ledger filters
  const [filterRound, setFilterRound] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterPlayer, setFilterPlayer] = useState<string>('');
  const [showVoided, setShowVoided] = useState<boolean>(true);

  // Track flash animations on player cards
  const [flashClasses, setFlashClasses] = useState<Record<string, string>>({});
  const lastKnownBalances = useRef<Record<string, number>>({});

  useEffect(() => {
    const newFlashes: Record<string, string> = {};
    players.forEach((p) => {
      const oldVal = lastKnownBalances.current[p.id];
      if (oldVal !== undefined && oldVal !== p.cash) {
        newFlashes[p.id] = p.cash > oldVal ? 'flash-credit' : 'flash-debit';
      }
      lastKnownBalances.current[p.id] = p.cash;
      prevBalances.set(p.id, p.cash);
    });

    if (Object.keys(newFlashes).length > 0) {
      setFlashClasses(newFlashes);
      const timer = setTimeout(() => {
        setFlashClasses({});
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [players, prevBalances]);

  if (!game) return null;

  const curr = game.currency || '₹';
  const activeCount = players.filter((p) => !p.is_bankrupt).length;
  const pendingJoins = remotePeers.filter((p) => p.status === 'pending').length;
  const connectedDevices = remotePeers.filter((p) => p.status === 'connected').length;
  const hostedBadge = sessionRole !== 'host' ? null : pendingJoins > 0 ? pendingJoins : connectedDevices;

  const handleFinishGame = async () => {
    if (!window.confirm('Are you sure you want to finish this game? The ledger will become read-only.')) return;
    try {
      await gameApi(`/games/${game.id}/finish`, { method: 'POST' });
      showToast('Game finished and archived!', 'info');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Failed to finish game', 'error');
    }
  };

  const handleExportCsv = () => {
    downloadGameCsv(game.id);
  };

  // Distinct categories in transactions for filter
  const distinctCategories = useMemo(() => {
    return Array.from(new Set(transactions.map((t) => t.account_category))).sort();
  }, [transactions]);

  // Filtered transactions for ledger table
  const filteredTransactions = useMemo(() => {
    let list = [...transactions];
    if (filterRound) list = list.filter((t) => String(t.round) === filterRound);
    if (filterCategory) list = list.filter((t) => t.account_category === filterCategory);
    if (!showVoided) list = list.filter((t) => !t.voided_by_txn);
    if (filterPlayer) {
      list = list.filter((t) => (t.entries || []).some((e) => e.account_ref === filterPlayer));
    }
    // Newest first
    list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return list;
  }, [transactions, filterRound, filterCategory, showVoided, filterPlayer]);

  return (
    <section id="view-active" className="view-panel">
      {/* Main Navigation Tabs */}
      <div className="main-view-tabs">
        <button
          className={`view-tab-btn ${activeTab === 'console' ? 'active' : ''}`}
          id="tab-btn-console"
          onClick={() => setActiveTab('console')}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span>Banker Console</span>
        </button>

        <button
          className={`view-tab-btn ${activeTab === 'ledger' ? 'active' : ''}`}
          id="tab-btn-ledger"
          onClick={() => setActiveTab('ledger')}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <span>Ledger Book</span>
          <span className="tab-count mono-num" id="tab-ledger-count">
            {transactions.length}
          </span>
        </button>

        <button
          className={`view-tab-btn ${activeTab === 'session' ? 'active' : ''}`}
          id="tab-btn-session"
          onClick={() => setActiveTab('session')}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M5 12.55a11 11 0 0 1 14.08 0" />
            <path d="M1.42 9a16 16 0 0 1 21.16 0" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          <span>Hosted Session</span>
          {hostedBadge !== null && (
            <span
              className={`tab-count mono-num ${pendingJoins > 0 ? 'alert' : ''}`}
              id="tab-session-count"
            >
              {hostedBadge}
            </span>
          )}
        </button>
      </div>

      {/* Subview 1: Banker Console */}
      {activeTab === 'console' && (
        <div id="subview-console" className="subview-content">
          {/* Game Status Banner if Finished */}
          {game.status === 'finished' && (
            <div id="finished-banner" className="finished-banner">
              <div>
                <h3>Session Archived</h3>
                <p>The double-entry ledger is now locked in read-only mode. Review final balances or export audit records.</p>
              </div>
              <button id="btn-export-csv-banner" className="btn btn-secondary btn-sm" onClick={handleExportCsv}>
                Download CSV
              </button>
            </div>
          )}

          {/* Top Row: Players Leaderboard & Wallet Grid */}
          <div className="section-heading">
            <div className="heading-with-badge">
              <h2>Player Wallets &amp; Balances</h2>
              <span className="meta-inline" id="active-players-badge">
                {activeCount} Active · {players.length} Total
              </span>
            </div>
            <div className="heading-actions">
              <button id="btn-export-csv" className="btn btn-secondary btn-sm" title="Download Ledger CSV" onClick={handleExportCsv}>
                Export CSV
              </button>
              {game.status === 'active' && (
                <button
                  id="btn-finish-game"
                  className="btn btn-danger-ghost btn-sm"
                  title="Finish and lock this game"
                  onClick={handleFinishGame}
                >
                  End Game
                </button>
              )}
            </div>
          </div>

          {/* Responsive Player Cards Grid */}
          <div id="player-cards-grid" className="player-cards-grid">
            {players.map((p) => {
              const flash = flashClasses[p.id] || '';
              return (
                <div
                  key={p.id}
                  className="player-card compact-player-card"
                  id={`player-card-${p.id}`}
                >
                  <div className="compact-card-top">
                    <div className="compact-card-name-box">
                      <span className="compact-player-name">{p.name}</span>
                      <span className="seat-meta">Seat {p.seat_no}</span>
                    </div>
                    <button
                      className="compact-stmt-btn"
                      onClick={() => openModal('player-statement', { player: p })}
                      title={`View Statement for ${p.name}`}
                    >
                      Statement
                    </button>
                  </div>
                  <div className={`compact-card-bottom ${flash}`}>
                    <span className="compact-wallet-label">Cash Balance</span>
                    <span className="compact-wallet-amount mono-num">{formatMoney(p.cash, curr)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Middle: Fast Transaction Center */}
          {game.status === 'active' && <TransferCard />}
        </div>
      )}

      {/* Subview 2: Dedicated Ledger Book Tab */}
      {activeTab === 'ledger' && (
        <div id="subview-ledger" className="subview-content">
          <div className="section-heading">
            <div className="heading-with-badge">
              <h2>Ledger Book</h2>
              <span className="meta-inline mono-num" id="ledger-count-label">
                {filteredTransactions.length} transactions
              </span>
            </div>
            <div className="heading-actions">
              <button id="btn-export-csv-tab" className="btn btn-secondary btn-sm" title="Download CSV" onClick={handleExportCsv}>
                Export CSV
              </button>
            </div>
          </div>

          <div className="card ledger-card">
            <div className="card-header ledger-header">
              <div className="ledger-title-box">
                <span className="text-muted text-sm">Double-entry audit log of all account debits and credits</span>
              </div>

              {/* Filters */}
              <div className="ledger-filters">
                <select
                  id="filter-round"
                  className="form-select-sm"
                  value={filterRound}
                  onChange={(e) => setFilterRound(e.target.value)}
                >
                  <option value="">All Rounds</option>
                  {Array.from({ length: game.current_round || 0 }, (_, i) => i + 1).map((r) => (
                    <option key={r} value={r}>
                      Round {r}
                    </option>
                  ))}
                </select>

                <select
                  id="filter-category"
                  className="form-select-sm"
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                >
                  <option value="">All Categories</option>
                  {distinctCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>

                <select
                  id="filter-player"
                  className="form-select-sm"
                  value={filterPlayer}
                  onChange={(e) => setFilterPlayer(e.target.value)}
                >
                  <option value="">All Counterparties</option>
                  {players.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <label className="checkbox-label" title="Show or hide voided / reversed transactions">
                  <input
                    type="checkbox"
                    id="filter-show-voided"
                    checked={showVoided}
                    onChange={(e) => setShowVoided(e.target.checked)}
                  />
                  <span>Show Voided</span>
                </label>
              </div>
            </div>

            <div className="card-body no-padding">
              <div className="table-container">
                <table className="ledger-table" id="ledger-table">
                  <thead>
                    <tr>
                      <th style={{ width: '100px' }}>Time</th>
                      <th style={{ width: '70px' }}>Round</th>
                      <th style={{ width: '160px' }}>Category</th>
                      <th>Counterparties (Dr → Cr)</th>
                      <th style={{ width: '130px', textAlign: 'right' }}>Amount</th>
                      <th>Description</th>
                      <th style={{ width: '90px', textAlign: 'center' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody id="ledger-tbody">
                    {filteredTransactions.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center text-muted p-4">
                          No ledger transactions match current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredTransactions.map((t) => {
                        const isVoided = Boolean(t.voided_by_txn);
                        let drRef = 'BANK';
                        let crRef = 'BANK';
                        (t.entries || []).forEach((e) => {
                          if (e.direction === 'DR') drRef = e.account_ref;
                          if (e.direction === 'CR') crRef = e.account_ref;
                        });

                        const drName = drRef === 'BANK' ? 'Bank Reserve' : players.find((p) => p.id === drRef)?.name || drRef;
                        const crName = crRef === 'BANK' ? 'Bank Reserve' : players.find((p) => p.id === crRef)?.name || crRef;
                        const timeStr = t.created_at ? t.created_at.split('T')[1]?.substring(0, 8) : '';

                        return (
                          <tr key={t.id} className={isVoided ? 'is-voided' : ''}>
                            <td className="text-xs text-muted mono-num">{timeStr}</td>
                            <td className="mono-num text-muted">R{t.round}</td>
                            <td>
                              <span className="category-text mono-num">{t.account_category}</span>
                            </td>
                            <td>
                              <div className="flow-pill-container">
                                <span className="counterparty-text">{drName}</span>
                                <span className="text-dim" aria-hidden="true">→</span>
                                <span className="counterparty-text">{crName}</span>
                              </div>
                            </td>
                            <td className="mono-num" style={{ textAlign: 'right', fontWeight: 600 }}>
                              {formatMoney(t.amount, curr)}
                            </td>
                            <td className="text-xs text-muted">{t.description || '-'}</td>
                            <td style={{ textAlign: 'center' }}>
                              {!isVoided && game.status === 'active' ? (
                                <button
                                  className="btn btn-ghost btn-xs text-ruby btn-trigger-void"
                                  onClick={() => openModal('confirm-void', { transaction: t })}
                                  title="Void transaction"
                                >
                                  Void
                                </button>
                              ) : isVoided ? (
                                <span className="voided-text">Voided</span>
                              ) : (
                                '-'
                              )}
                            </td>
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
      )}

      {/* Subview 3: Hosted Session */}
      {activeTab === 'session' && (
        <div id="subview-session" className="subview-content">
          <HostSessionPanel />
        </div>
      )}
    </section>
  );
};
