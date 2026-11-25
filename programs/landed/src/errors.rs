use anchor_lang::prelude::*;

#[error_code]
pub enum LandedError {
    #[msg("Caller is not authorized for this instruction")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid configuration value")]
    InvalidConfig,
    #[msg("Program is paused for entries and deposits")]
    Paused,
    #[msg("Table is close-only: no new entries")]
    CloseOnly,
    #[msg("Faucet cooldown has not elapsed")]
    FaucetCooldown,
    #[msg("Faucet lifetime cap reached")]
    FaucetCapReached,
    #[msg("Amount below minimum")]
    AmountTooSmall,
    #[msg("Amount above maximum")]
    AmountTooLarge,
    #[msg("Insufficient available balance")]
    InsufficientBalance,
    #[msg("Deposit receipt out of order")]
    OutOfOrder,
    #[msg("Invalid receipt account")]
    InvalidReceipt,
    #[msg("Invalid ledger account")]
    InvalidLedger,
    #[msg("Withdrawal ring is full: wait for earlier payouts to be acknowledged")]
    RingFull,
    #[msg("No pending withdrawal with that nonce in the committed ledger")]
    NotPending,
    #[msg("Vault cannot cover this payout yet; it stays owed")]
    VaultInsufficient,
    #[msg("Injected fault (Fault Lab): this payout action fails on purpose")]
    InjectedFault,
    #[msg("Fault injection is not compiled into this build")]
    FaultLabDisabled,
    #[msg("Destination must be the owner's dUSDC associated token account")]
    InvalidDestination,
    #[msg("Session is invalid, expired, or for another program/owner")]
    InvalidSession,
    #[msg("Session spend cap exceeded")]
    SessionCapExceeded,
    #[msg("Round is not open")]
    RoundNotOpen,
    #[msg("Round has already closed for entries")]
    RoundClosed,
    #[msg("Round cannot be closed yet")]
    RoundNotDue,
    #[msg("Per-player round cap exceeded")]
    PlayerCapExceeded,
    #[msg("Table is full")]
    TableFull,
    #[msg("Round is not awaiting VRF")]
    NotAwaitingVrf,
    #[msg("Too early to retry VRF")]
    RetryTooEarly,
    #[msg("Maximum VRF attempts reached; wait for void")]
    RetryExhausted,
    #[msg("Too early to void the round")]
    VoidTooEarly,
    #[msg("Round has not been drawn")]
    NotDrawn,
    #[msg("Round already settled")]
    AlreadySettled,
    #[msg("Wrong winner ledger")]
    WrongWinner,
    #[msg("Refund ledgers missing or out of order")]
    BadRefundAccounts,
    #[msg("Withdrawal is too fresh to force a commit")]
    CommitTooEarly,
    #[msg("Nothing pending to commit")]
    NothingPending,
    #[msg("Wrong fee vault for this validator")]
    WrongFeeVault,
    #[msg("Only a solo entrant can leave a round")]
    NotSolo,
}
