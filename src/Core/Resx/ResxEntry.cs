// <copyright file="ResxEntry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Resx;

/// <summary>
/// One <c>&lt;data&gt;</c> resource entry parsed from a <c>.resx</c> file
/// (ADR-0142). Mirrors the subset of the resx schema the strongly-typed
/// designer generator cares about: the resource's <see cref="Name"/>, its
/// literal or base64-encoded <see cref="Value"/>, the optional developer
/// <see cref="Comment"/> (used to seed the generated property's doc comment),
/// and — for a non-string resource — the assembly-qualified <see cref="TypeName"/>
/// and/or <see cref="MimeType"/> that select how the property reads the value
/// back out of the <c>ResourceManager</c>.
/// </summary>
public sealed class ResxEntry
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ResxEntry"/> class.
    /// </summary>
    /// <param name="name">The resource's <c>name</c> attribute.</param>
    /// <param name="value">The resource's <c>&lt;value&gt;</c> text.</param>
    /// <param name="comment">The resource's optional <c>&lt;comment&gt;</c> text.</param>
    /// <param name="typeName">The resource's optional <c>type</c> attribute (assembly-qualified CLR type name).</param>
    /// <param name="mimeType">The resource's optional <c>mimetype</c> attribute (marks a base64-encoded binary payload).</param>
    public ResxEntry(string name, string value, string comment, string typeName, string mimeType)
    {
        this.Name = name;
        this.Value = value;
        this.Comment = comment;
        this.TypeName = typeName;
        this.MimeType = mimeType;
    }

    /// <summary>Gets the resource's <c>name</c> attribute — the resx key.</summary>
    public string Name { get; }

    /// <summary>Gets the resource's raw <c>&lt;value&gt;</c> text.</summary>
    public string Value { get; }

    /// <summary>Gets the resource's optional <c>&lt;comment&gt;</c> text, or an empty string.</summary>
    public string Comment { get; }

    /// <summary>
    /// Gets the resource's optional <c>type</c> attribute — an assembly-qualified
    /// CLR type name (e.g. <c>System.Byte[], mscorlib</c>) present on every
    /// non-string resource. Empty for a plain string resource.
    /// </summary>
    public string TypeName { get; }

    /// <summary>
    /// Gets the resource's optional <c>mimetype</c> attribute, present when
    /// <see cref="Value"/> is a base64-encoded binary payload. Empty for a
    /// plain string resource.
    /// </summary>
    public string MimeType { get; }

    /// <summary>
    /// Gets a value indicating whether this resource is a plain string —
    /// the dominant case, and the only one that reads back through
    /// <c>ResourceManager.GetString</c> rather than <c>GetObject</c>.
    /// </summary>
    public bool IsString => string.IsNullOrEmpty(this.TypeName) && string.IsNullOrEmpty(this.MimeType);
}
