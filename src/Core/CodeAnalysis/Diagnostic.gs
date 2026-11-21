// <copyright file="Diagnostic.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable

/// Code analysis diagnostic information.
class Diagnostic {
    /// Initializes a new instance of the (cref:Diagnostic) class.
    /// @param location Text location in the document where this diagnostic information originates from.
    /// @param id The stable diagnostic identifier (e.g. `GS0001`).
    /// @param severity The severity of the diagnostic.
    /// @param message Diagnostic information message.
    init(location TextLocation, id string, severity DiagnosticSeverity, message string) {
        Location = location
        Id = id
        Severity = severity
        Message = message
        AdditionalLocations = ImmutableArray[TextLocation].Empty
        Properties = ImmutableDictionary[string, string?].Empty
        MessageArguments = ImmutableArray[string].Empty
        Suggestions = ImmutableArray[DiagnosticSuggestion].Empty
    }

    /// Initializes a new instance of the (cref:Diagnostic) class with
    /// a default severity of (cref:DiagnosticSeverity.Error) and no
    /// stable identifier. Provided for backward compatibility.
    /// @param location Text location in the document where this diagnostic information originates from.
    /// @param message Diagnostic information message.
    convenience init(location TextLocation, message string) {
        init(location, "GS0000", DiagnosticSeverity.Error, message)
    }

    private init(
        descriptor DiagnosticDescriptor,
        location TextLocation,
        severity DiagnosticSeverity,
        message string,
        additionalLocations ImmutableArray[TextLocation],
        properties ImmutableDictionary[string, string?],
        messageArguments ImmutableArray[string],
        suggestions ImmutableArray[DiagnosticSuggestion]
    ) {
        Descriptor = descriptor
        Location = location
        Id = descriptor.Id
        Severity = severity
        Message = message
        AdditionalLocations = additionalLocations
        Properties = properties
        MessageArguments = messageArguments
        Suggestions = suggestions
    }

    // ADR-0225: a copy that keeps every field and sets the prefix finality.
    private init(
        source Diagnostic,
        severity DiagnosticSeverity,
        prefixFinality DiagnosticFinality,
        prefixReason string
    ) {
        Descriptor = source.Descriptor
        Location = source.Location
        Id = source.Id
        Severity = severity
        Message = source.Message
        AdditionalLocations = source.AdditionalLocations
        Properties = source.Properties
        MessageArguments = source.MessageArguments
        Suggestions = source.Suggestions
        PrefixFinality = prefixFinality
        this.prefixReason = prefixReason
    }

    // ADR-0227 D4: a copy at other locations, for the body-local delta.
    private init(
        source Diagnostic,
        location TextLocation,
        additionalLocations ImmutableArray[TextLocation],
        suggestions ImmutableArray[DiagnosticSuggestion]
    ) {
        Descriptor = source.Descriptor
        Location = location
        Id = source.Id
        Severity = source.Severity
        Message = source.Message
        AdditionalLocations = additionalLocations
        Properties = source.Properties
        MessageArguments = source.MessageArguments
        Suggestions = suggestions
        PrefixFinality = source.PrefixFinality
        this.prefixReason = source.prefixReason
    }

    /// Gets the stable diagnostic identifier (e.g. `GS0001`).
    prop Id string {
        get;
    }

    /// Gets the severity of this diagnostic.
    prop Severity DiagnosticSeverity {
        get;
    }

    /// Gets the text location in the document where this diagnostic information originates from.
    prop Location TextLocation {
        get;
    }

    /// Gets the diagnostic information message.
    prop Message string {
        get;
    }

    /// Gets the arguments of the message format, each formatted as the message formats it, in
    /// order (ADR-0227 D2). A code fix reads them instead of the message text. Empty when the
    /// producer did not record them.
    prop MessageArguments ImmutableArray[string] {
        get;
    }

    /// Gets the fixes that the compiler attached when it reported the diagnostic (ADR-0227 D2).
    /// Empty for most diagnostics. Equality and de-duplication do not read them.
    prop Suggestions ImmutableArray[DiagnosticSuggestion] {
        get;
    }

    /// Gets the descriptor this diagnostic was created from, or `null`
    /// for diagnostics produced through the pre-ADR-0169 constructor paths.
    prop Descriptor DiagnosticDescriptor? {
        get;
    }

    /// Gets locations related to the diagnostic beyond its primary
    /// (cref:Location) (e.g. the other declaration in a duplicate
    /// definition). Empty for most diagnostics.
    prop AdditionalLocations ImmutableArray[TextLocation] {
        get;
    }

    /// Gets an immutable property bag attached by the producer, consumed by
    /// tooling such as code fixes. Empty for most diagnostics.
    prop Properties ImmutableDictionary[string, string?] {
        get;
    }

    /// Gets the finality that the binder gave this diagnostic in a prefix bind (ADR-0225).
    /// It is (cref:DiagnosticFinality.Final) for every diagnostic of a complete program.
    internal prop PrefixFinality DiagnosticFinality {
        get;
    }

    /// Gets the premise that makes the diagnostic future-dependent, or an empty string (ADR-0225).
    internal prop PrefixReason string -> prefixReason ?? string.Empty

    private var prefixReason string?

    /// Gets a value indicating whether this diagnostic is an error.
    prop IsError bool -> Severity == DiagnosticSeverity.Error

    /// Returns a copy of this diagnostic with the given effective severity,
    /// preserving all other data. Used by severity configuration
    /// (`/gsdiag:`, `/warnaserror`).
    /// @param severity The effective severity for the copy.
    /// @returns A diagnostic identical to this one except for its severity.
    func WithSeverity(severity DiagnosticSeverity) Diagnostic {
        if severity == Severity {
            return this
        }
        return Diagnostic(this, severity, PrefixFinality, PrefixReason)
    }

    /// Returns a copy of this diagnostic at other locations, with every other field kept: the
    /// diagnostic as a bind of the edited text reports it (ADR-0227 D4, issue #6128).
    /// @param location The primary location of the copy.
    /// @param additionalLocations The additional locations of the copy.
    /// @param suggestions The suggestions of the copy, with their changes on the edited text.
    /// @returns The copy.
    internal func WithLocations(
        location TextLocation,
        additionalLocations ImmutableArray[TextLocation],
        suggestions ImmutableArray[DiagnosticSuggestion]
    ) Diagnostic {
        return Diagnostic(this, location, additionalLocations, suggestions)
    }

    /// Returns a copy of this diagnostic with the given prefix finality (ADR-0225).
    /// @param finality The finality of the copy.
    /// @param reason The premise of the finality.
    /// @returns The copy.
    internal func WithPrefixFinality(finality DiagnosticFinality, reason string) Diagnostic -> Diagnostic(
        this,
        Severity,
        finality,
        reason
    )

    /// Diagnostic information message.
    /// @returns A string with the message.
    override func ToString() string -> Message

    shared {
        /// Creates a diagnostic from a descriptor, formatting the descriptor's
        /// message template with [`messageArguments`](paramref) and using the
        /// descriptor's default severity.
        /// @param descriptor The rule the diagnostic instantiates.
        /// @param location The primary location of the diagnostic.
        /// @param messageArguments Arguments for the descriptor's message template.
        /// @returns The created diagnostic.
        func Create(
            descriptor DiagnosticDescriptor,
            location TextLocation,
            messageArguments ...object?
        ) Diagnostic -> Create(
            descriptor,
            location,
            ImmutableArray[TextLocation].Empty,
            ImmutableDictionary[string, string?].Empty,
            messageArguments
        )

        /// Creates a diagnostic from a descriptor with additional locations and a
        /// property bag.
        /// @param descriptor The rule the diagnostic instantiates.
        /// @param location The primary location of the diagnostic.
        /// @param additionalLocations Locations related to the diagnostic beyond the primary one.
        /// @param properties A property bag for tooling; `default` means empty.
        /// @param messageArguments Arguments for the descriptor's message template.
        /// @returns The created diagnostic.
        func Create(
            descriptor DiagnosticDescriptor,
            location TextLocation,
            additionalLocations ImmutableArray[TextLocation],
            properties ImmutableDictionary[string, string?]?,
            messageArguments ...object?
        ) Diagnostic {
            let message = if messageArguments.Length > 0 {
                string.Format(descriptor.MessageFormat, messageArguments)
            } else {
                descriptor.MessageFormat
            }
            return Diagnostic(
                descriptor,
                location,
                descriptor.DefaultSeverity,
                message,
                if additionalLocations.IsDefault {
                    ImmutableArray[TextLocation].Empty
                } else {
                    additionalLocations
                },
                properties ?? ImmutableDictionary[string, string?].Empty,
                FormatArguments(messageArguments),
                ImmutableArray[DiagnosticSuggestion].Empty
            )
        }

        /// Creates a diagnostic of the compiler's report funnel (ADR-0227 D2). It keeps the
        /// descriptor and the message arguments, and uses the given severity.
        internal func CreateReported(
            descriptor DiagnosticDescriptor,
            location TextLocation,
            severity DiagnosticSeverity,
            messageArguments[]object?,
            suggestions ImmutableArray[DiagnosticSuggestion] = default(ImmutableArray[DiagnosticSuggestion])
        ) Diagnostic -> Diagnostic(
            descriptor,
            location,
            severity,
            string.Format(descriptor.MessageFormat, messageArguments),
            ImmutableArray[TextLocation].Empty,
            ImmutableDictionary[string, string?].Empty,
            FormatArguments(messageArguments),
            if suggestions.IsDefault {
                ImmutableArray[DiagnosticSuggestion].Empty
            } else {
                suggestions
            }
        )

        // Each argument formatted as string.Format formats it in the message.
        private func FormatArguments(messageArguments[]object?) ImmutableArray[string] {
            if messageArguments.Length == 0 {
                return ImmutableArray[string].Empty
            }
            let builder = ImmutableArray.CreateBuilder[string](messageArguments.Length)
            for argument in messageArguments {
                builder.Add(string.Format("{0}", argument))
            }
            return builder.MoveToImmutable()
        }
    }
}
