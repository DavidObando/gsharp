// <copyright file="DiagnosticDescriptor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Describes a diagnostic rule: its stable identifier, message format, and
/// default presentation. Compiler-owned descriptors live in
/// <see cref="DiagnosticDescriptors"/>; analyzer assemblies declare their own
/// (see ADR-0169).
/// </summary>
public sealed class DiagnosticDescriptor
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DiagnosticDescriptor"/>
    /// class with the full Roslyn-shaped rule metadata.
    /// </summary>
    /// <param name="id">The stable diagnostic identifier (e.g. <c>GS0001</c>).</param>
    /// <param name="title">A short, non-parameterized title for the rule.</param>
    /// <param name="messageFormat">The <see cref="string.Format(string, object[])"/> template for produced messages.</param>
    /// <param name="category">The rule category (e.g. <c>Compiler</c> or an analyzer-defined category).</param>
    /// <param name="defaultSeverity">The severity produced when no configuration overrides it.</param>
    /// <param name="isEnabledByDefault">Whether the rule runs unless explicitly enabled.</param>
    /// <param name="description">An optional longer description of the rule.</param>
    /// <param name="helpLinkUri">An optional link to documentation for the rule.</param>
    public DiagnosticDescriptor(
        string id,
        string title,
        string messageFormat,
        string category,
        DiagnosticSeverity defaultSeverity,
        bool isEnabledByDefault,
        string? description = null,
        string? helpLinkUri = null)
    {
        Id = id;
        Title = title;
        MessageFormat = messageFormat;
        Category = category;
        DefaultSeverity = defaultSeverity;
        IsEnabledByDefault = isEnabledByDefault;
        Description = description;
        HelpLinkUri = helpLinkUri;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="DiagnosticDescriptor"/>
    /// class from the compact compiler-internal shape. The title defaults to
    /// the id, the category to <c>Compiler</c>, and the rule is enabled by
    /// default — preserving the semantics of every pre-ADR-0169 descriptor.
    /// </summary>
    /// <param name="id">The stable diagnostic identifier (e.g. <c>GS0001</c>).</param>
    /// <param name="severity">The default severity of the rule.</param>
    /// <param name="messageFormat">The <see cref="string.Format(string, object[])"/> template for produced messages.</param>
    public DiagnosticDescriptor(string id, DiagnosticSeverity severity, string messageFormat)
        : this(id, id, messageFormat, "Compiler", severity, isEnabledByDefault: true)
    {
    }

    /// <summary>
    /// Gets the stable diagnostic identifier (e.g. <c>GS0001</c>).
    /// </summary>
    public string Id { get; }

    /// <summary>
    /// Gets the short, non-parameterized title for the rule.
    /// </summary>
    public string Title { get; }

    /// <summary>
    /// Gets the <see cref="string.Format(string, object[])"/> template for produced messages.
    /// </summary>
    public string MessageFormat { get; }

    /// <summary>
    /// Gets the rule category (e.g. <c>Compiler</c> or an analyzer-defined category).
    /// </summary>
    public string Category { get; }

    /// <summary>
    /// Gets the severity produced when no configuration overrides it.
    /// </summary>
    public DiagnosticSeverity DefaultSeverity { get; }

    /// <summary>
    /// Gets a value indicating whether the rule runs unless explicitly disabled.
    /// </summary>
    public bool IsEnabledByDefault { get; }

    /// <summary>
    /// Gets the optional longer description of the rule.
    /// </summary>
    public string? Description { get; }

    /// <summary>
    /// Gets the optional link to documentation for the rule.
    /// </summary>
    public string? HelpLinkUri { get; }

    /// <summary>
    /// Gets the default severity of the rule. Alias for
    /// <see cref="DefaultSeverity"/> preserved for the compiler's internal
    /// report paths, which predate the default/effective severity split.
    /// </summary>
    public DiagnosticSeverity Severity => DefaultSeverity;
}
