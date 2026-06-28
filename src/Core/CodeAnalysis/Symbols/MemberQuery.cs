#nullable disable

// <copyright file="MemberQuery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0112: describes which members the canonical member-resolution layer
/// (<see cref="TypeMemberModel"/>) should surface — the static/instance/inherited
/// axes and a kind mask.
/// </summary>
public readonly struct MemberQuery
{
    /// <summary>Initializes a new instance of the <see cref="MemberQuery"/> struct.</summary>
    /// <param name="includeInstance">Whether instance members are surfaced.</param>
    /// <param name="includeStatic">Whether static (<c>shared</c>) members are surfaced.</param>
    /// <param name="includeInherited">Whether members from base classes are surfaced.</param>
    /// <param name="kinds">The member-kind mask.</param>
    public MemberQuery(bool includeInstance, bool includeStatic, bool includeInherited, MemberKinds kinds)
    {
        this.IncludeInstance = includeInstance;
        this.IncludeStatic = includeStatic;
        this.IncludeInherited = includeInherited;
        this.Kinds = kinds;
    }

    /// <summary>Gets a value indicating whether instance members are surfaced.</summary>
    public bool IncludeInstance { get; }

    /// <summary>Gets a value indicating whether static (<c>shared</c>) members are surfaced.</summary>
    public bool IncludeStatic { get; }

    /// <summary>Gets a value indicating whether members from base classes are surfaced.</summary>
    public bool IncludeInherited { get; }

    /// <summary>Gets the member-kind mask.</summary>
    public MemberKinds Kinds { get; }

    /// <summary>
    /// Gets a query matching every member (instance + static + inherited, all
    /// kinds). This mirrors the historic language-server enumeration semantics
    /// (property → field → event → method, instance then static, walking the
    /// base chain) and is the parity-preserving default for hover/lookup.
    /// </summary>
    public static MemberQuery All { get; } = new(includeInstance: true, includeStatic: true, includeInherited: true, MemberKinds.All);

    /// <summary>Gets a query matching instance members of the given kinds, walking the base chain.</summary>
    /// <param name="kinds">The member-kind mask.</param>
    /// <returns>The configured query.</returns>
    public static MemberQuery Instance(MemberKinds kinds = MemberKinds.All)
        => new(includeInstance: true, includeStatic: false, includeInherited: true, kinds);

    /// <summary>Gets a query matching static members of the given kinds (no base-chain walk, matching historic static-completion semantics).</summary>
    /// <param name="kinds">The member-kind mask.</param>
    /// <returns>The configured query.</returns>
    public static MemberQuery Static(MemberKinds kinds = MemberKinds.All)
        => new(includeInstance: false, includeStatic: true, includeInherited: false, kinds);

    /// <summary>Returns a copy of this query with the kind mask replaced.</summary>
    /// <param name="kinds">The new kind mask.</param>
    /// <returns>The adjusted query.</returns>
    public MemberQuery WithKinds(MemberKinds kinds)
        => new(this.IncludeInstance, this.IncludeStatic, this.IncludeInherited, kinds);
}
