import React, { useState, useEffect, useMemo } from 'react';
import { useGame } from '../context/GameContext';
import { formatMoney, generateIdemKey } from '../lib/constants';
import { gameApi } from '../lib/gameApi';
import { sound } from '../lib/sound';
import { ACCOUNT_CATEGORIES } from '../lib/domain';

export const TransferCard: React.FC<{ targetPlayerId?: string | null }> = ({ targetPlayerId }) => {
  const {
    game,
    players,
    appMode,
    myPlayerId,
    activeTransferTab,
    setActiveTransferTab,
    openModal,
    showToast,
    refreshActiveGame,
    customDesc,
    setCustomDesc,
  } = useGame();

  const isPlayerMode = appMode === 'player' && !!myPlayerId;
  const me = isPlayerMode ? players.find((p) => p.id === myPlayerId) : null;
  const curr = game?.currency || '₹';

  // Form states
  const [fromAccount, setFromAccount] = useState<string>('BANK');
  const [toAccount, setToAccount] = useState<string>('BANK');
  const [category, setCategory] = useState<string>('RENT');
  const [amount, setAmount] = useState<string>('');

  // Handle external selection shortcut (e.g. from roster)
  useEffect(() => {
    if (targetPlayerId) {
      setToAccount(targetPlayerId);
      setCategory('RENT');
    }
  }, [targetPlayerId]);

  // Adjust options and defaults when tab or mode changes
  useEffect(() => {
    const activePlayers = players.filter((p) => !p.is_bankrupt);
    if (isPlayerMode && me) {
      setFromAccount(me.id);
      if (toAccount === me.id) {
        const other = activePlayers.find((p) => p.id !== me.id);
        setToAccount(other ? other.id : 'BANK');
      }
    } else {
      // Banker mode: only 'bank-pay' and 'custom'
      if (activeTransferTab === 'bank-pay') {
        setFromAccount('BANK');
        if (!['SALARY', 'LOAN', 'MORTGAGE', 'INCOME', 'GIFT'].includes(category)) {
          setCategory('SALARY');
        }
        if (toAccount === 'BANK' && activePlayers.length > 0) {
          setToAccount(activePlayers[0].id);
        }
      } else {
        if (fromAccount === toAccount && activePlayers.length > 0) {
          setToAccount(fromAccount === 'BANK' ? activePlayers[0].id : 'BANK');
        }
      }
    }
  }, [activeTransferTab, isPlayerMode, me, players]);

  // Compute balances
  const fromBalance = useMemo(() => {
    if (fromAccount === 'BANK') return game?.bank_balance ?? 0;
    const p = players.find((x) => x.id === fromAccount);
    return p ? p.cash : 0;
  }, [fromAccount, game, players]);

  const toBalance = useMemo(() => {
    if (toAccount === 'BANK') return game?.bank_balance ?? 0;
    const p = players.find((x) => x.id === toAccount);
    return p ? p.cash : 0;
  }, [toAccount, game, players]);

  // Compute helper text
  const helperText = useMemo(() => {
    if (isPlayerMode) {
      return 'Send funds from your wallet to another player or Bank Reserve';
    }
    return activeTransferTab === 'bank-pay'
      ? 'Disburse funds from Bank Reserve to a player'
      : 'Transfer between any accounts and categories';
  }, [activeTransferTab, isPlayerMode]);

  // Auto-suggested description placeholder
  const autoDesc = useMemo(() => {
    const fromName = fromAccount === 'BANK' ? 'Bank' : players.find((p) => p.id === fromAccount)?.name || 'Payer';
    const toName = toAccount === 'BANK' ? 'Bank' : players.find((p) => p.id === toAccount)?.name || 'Recipient';
    return `${category}: ${fromName} -> ${toName}`;
  }, [fromAccount, toAccount, category, players]);

  // Validation
  const numAmount = parseInt(amount || '0', 10);
  let validationError = '';

  if (fromAccount === toAccount) {
    validationError = 'Payer and Recipient cannot be the same account';
  } else if (numAmount > fromBalance) {
    if (fromAccount === 'BANK') {
      validationError = `Bank reserve has insufficient funds (Deficit: ${formatMoney(numAmount - fromBalance, curr)})`;
    } else {
      validationError = `Insufficient cash (Player has ${formatMoney(fromBalance, curr)}, deficit ${formatMoney(numAmount - fromBalance, curr)})`;
    }
  }

  const isValid = !validationError && numAmount > 0;

  const handleQuickAdd = (add: number) => {
    const cur = parseInt(amount || '0', 10);
    setAmount(String(cur + add));
  };

  const handleClearAmount = () => {
    setAmount('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || !game) return;

    const fromAcc = fromAccount === 'BANK' ? { type: 'bank', id: 'BANK' } : { type: 'player', id: fromAccount };
    const toAcc = toAccount === 'BANK' ? { type: 'bank', id: 'BANK' } : { type: 'player', id: toAccount };
    const desc = customDesc.trim() || autoDesc;
    const idemKey = generateIdemKey('transfer');

    try {
      await gameApi(`/games/${game.id}/transfers`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: {
          from: fromAcc,
          to: toAcc,
          amount: numAmount,
          account_category: category,
          description: desc,
        },
      });

      sound.playCoin();
      showToast(`Transferred ${formatMoney(numAmount, curr)} (${category})`, 'success');
      setAmount('');
      setCustomDesc('');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Transfer failed', 'error');
    }
  };

  return (
    <div className="card transfer-center-card" id="transfer-card">
      <div className="card-header tab-header">
        <div className="tabs-nav">
          {isPlayerMode ? (
            <span className="transfer-card-title">Send Payment</span>
          ) : (
            <>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'bank-pay' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('bank-pay')}
              >
                Bank Payout
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'custom' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('custom')}
              >
                Custom Transfer
              </button>
            </>
          )}
        </div>
        <span className="text-muted text-xs helper-text" id="tab-helper-text">
          {helperText}
        </span>
      </div>

      <div className="card-body">
        <form id="form-transfer" autoComplete="off" onSubmit={handleSubmit}>
          {/* Flow Selector Row */}
          <div className={`transfer-flow-row ${isPlayerMode ? 'player-mode-flow' : ''}`}>
            {!isPlayerMode && (
              <>
                {/* From Selector */}
                <div className="form-group flow-entity" id="flow-from-group">
                  <label className="flow-label" htmlFor="transfer-from-select">From (Payer)</label>
                  <select
                    id="transfer-from-select"
                    className="form-select flow-select"
                    value={fromAccount}
                    disabled={activeTransferTab === 'bank-pay'}
                    onChange={(e) => setFromAccount(e.target.value)}
                    required
                  >
                    <option value="BANK">Bank Reserve</option>
                    {players
                      .filter((p) => !p.is_bankrupt)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                  <div className="balance-hint mono-num" id="from-balance-hint">
                    Available: {formatMoney(fromBalance, curr)}
                  </div>
                </div>

                {/* Compact Inline Arrow */}
                <div className="flow-arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </div>
              </>
            )}

            {/* To Selector */}
            <div className="form-group flow-entity" id="flow-to-group">
              <label className="flow-label" htmlFor="transfer-to-select">To (Recipient)</label>
              <select
                id="transfer-to-select"
                className="form-select flow-select"
                value={toAccount}
                onChange={(e) => setToAccount(e.target.value)}
                required
              >
                {(isPlayerMode || activeTransferTab === 'custom') && (
                  <option value="BANK">Bank Reserve</option>
                )}
                {players
                  .filter((p) => !p.is_bankrupt && (isPlayerMode ? p.id !== me?.id : true))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <div className="balance-hint mono-num" id="to-balance-hint">
                Available: {formatMoney(toBalance, curr)}
              </div>
            </div>

            {/* Category */}
            <div className="form-group flow-category" id="flow-cat-group">
              <label className="flow-label" htmlFor="transfer-category-select">Category</label>
              <select
                id="transfer-category-select"
                className="form-select flow-select"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {ACCOUNT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Amount Row */}
          <div className="amount-row compact-amount-row">
            <div className="form-group amount-input-group">
              <label htmlFor="transfer-amount">
                Amount (<span className="currency-sym">{curr}</span>)
              </label>
              <div className="amount-with-note">
                <div className="input-with-sym">
                  <span className="sym-prefix mono-num">{curr}</span>
                  <input
                    type="number"
                    id="transfer-amount"
                    className="form-input amount-input mono-num"
                    placeholder="0"
                    min="1"
                    step="1"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  id="btn-open-desc-modal"
                  className="btn btn-secondary btn-note"
                  title="Add / View memo description"
                  onClick={() => openModal('transfer-desc', { autoDesc })}
                >
                  <span className="note-label">Memo</span>
                  {customDesc && <span id="desc-dot" className="desc-dot" style={{ display: 'inline-block' }} />}
                </button>
              </div>
            </div>

            {/* Quick Amount Chips */}
            <div className="quick-amount-chips">
              <button type="button" className="chip-btn mono-num" onClick={() => handleQuickAdd(100)}>
                +100
              </button>
              <button type="button" className="chip-btn mono-num" onClick={() => handleQuickAdd(500)}>
                +500
              </button>
              <button type="button" className="chip-btn mono-num" onClick={() => handleQuickAdd(1000)}>
                +1k
              </button>
              <button type="button" className="chip-btn chip-clear" id="chip-clear" onClick={handleClearAmount}>
                Clear
              </button>
            </div>
          </div>

          {/* Submit Row */}
          <div className="submit-row compact-submit-row">
            <div id="transfer-validation-msg" className="validation-msg">
              {validationError}
            </div>
            <button
              type="submit"
              id="btn-submit-transfer"
              className="btn btn-emerald btn-lg btn-block"
              disabled={!isValid}
            >
              Post Transfer
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
