// <copyright file="IlVerifyStatus.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.Pipeline;

/// <summary>
/// The status of an IL-verify run (ADR-0115 §C, stage 3).
/// </summary>
public enum IlVerifyStatus
{
    /// <summary>Verification was bypassed (env switch or no assembly).</summary>
    Skipped,

    /// <summary>Verification ran and reported no (non-ignored) errors.</summary>
    Passed,

    /// <summary>Verification ran and reported real errors.</summary>
    Failed,

    /// <summary>
    /// Verification did not complete because ilverify crashed or otherwise
    /// exited without its normal pass/fail result.
    /// </summary>
    Incomplete,
}
