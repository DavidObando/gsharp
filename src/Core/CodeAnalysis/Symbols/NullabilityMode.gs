// <copyright file="NullabilityMode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// ADR-0186: how a compilation reads nullability-<em>oblivious</em> imported
/// reference positions. Selected by `--nullability=<mode>` (equivalently
/// `/nullability:<mode>`).
///
/// This is modelled as a named mode rather than a boolean because ADR-0186 §9
/// adds a third value, (cref:Oblivious) — a declaration-scope switch for
/// cs2gs — to the same switch (step 5). It is a third <em>value</em> rather
/// than a second axis because the combination an axis would add, "ADR-0136's
/// `T?` import reading plus oblivious source declarations", has no
/// consumer: an oblivious declaration exists to be read as `T!`, and only
/// a mode that reads `T!` can say so.
///
/// <b>Spelling, reconciled with ADR-0186 §9.</b> §9 names the switch's values
/// `enabled|oblivious`, default `enabled`, where "enabled" means
/// "source declarations are nullability-enabled". Steps 1–3 had already given
/// `enabled` a different meaning on this switch — ADR-0136's import
/// reading — so §9's "enabled" is spelled `platform-types` here (the
/// default), and `enabled` keeps its step-1 meaning.
enum NullabilityMode {
    Enabled,
    PlatformTypes,
    Oblivious
}
