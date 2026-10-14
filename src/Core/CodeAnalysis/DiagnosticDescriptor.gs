// <copyright file="DiagnosticDescriptor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

/// Describes a diagnostic rule: its stable identifier, message format, and
/// default presentation. Compiler-owned descriptors live in
/// (cref:DiagnosticDescriptors); analyzer assemblies declare their own
/// (see ADR-0169).
class DiagnosticDescriptor {
    /// Initializes a new instance of the (cref:DiagnosticDescriptor)
    /// class with the full Roslyn-shaped rule metadata.
    /// @param id The stable diagnostic identifier (e.g. `GS0001`).
    /// @param title A short, non-parameterized title for the rule.
    /// @param messageFormat The (cref:string.Format(string, object[])) template for produced messages.
    /// @param category The rule category (e.g. `Compiler` or an analyzer-defined category).
    /// @param defaultSeverity The severity produced when no configuration overrides it.
    /// @param isEnabledByDefault Whether the rule runs unless explicitly enabled.
    /// @param description An optional longer description of the rule.
    /// @param helpLinkUri An optional link to documentation for the rule.
    init(
        id string,
        title string,
        messageFormat string,
        category string,
        defaultSeverity DiagnosticSeverity,
        isEnabledByDefault bool,
        description string? = nil,
        helpLinkUri string? = nil
    ) {
        Id = id
        Title = title
        MessageFormat = messageFormat
        Category = category
        DefaultSeverity = defaultSeverity
        IsEnabledByDefault = isEnabledByDefault
        Description = description
        HelpLinkUri = helpLinkUri
    }

    /// Initializes a new instance of the (cref:DiagnosticDescriptor)
    /// class from the compact compiler-internal shape. The title defaults to
    /// the id, the category to `Compiler`, and the rule is enabled by
    /// default — preserving the semantics of every pre-ADR-0169 descriptor.
    /// @param id The stable diagnostic identifier (e.g. `GS0001`).
    /// @param severity The default severity of the rule.
    /// @param messageFormat The (cref:string.Format(string, object[])) template for produced messages.
    convenience init(id string, severity DiagnosticSeverity, messageFormat string) {
        init(id, id, messageFormat, "Compiler", severity, true, nil, nil)
    }

    /// Gets the stable diagnostic identifier (e.g. `GS0001`).
    prop Id string {
        get;
    }

    /// Gets the short, non-parameterized title for the rule.
    prop Title string {
        get;
    }

    /// Gets the (cref:string.Format(string, object[])) template for produced messages.
    prop MessageFormat string {
        get;
    }

    /// Gets the rule category (e.g. `Compiler` or an analyzer-defined category).
    prop Category string {
        get;
    }

    /// Gets the severity produced when no configuration overrides it.
    prop DefaultSeverity DiagnosticSeverity {
        get;
    }

    /// Gets a value indicating whether the rule runs unless explicitly disabled.
    prop IsEnabledByDefault bool {
        get;
    }

    /// Gets the optional longer description of the rule.
    prop Description string? {
        get;
    }

    /// Gets the optional link to documentation for the rule.
    prop HelpLinkUri string? {
        get;
    }

    /// Gets the default severity of the rule. Alias for
    /// (cref:DefaultSeverity) preserved for the compiler's internal
    /// report paths, which predate the default/effective severity split.
    prop Severity DiagnosticSeverity -> DefaultSeverity
}
