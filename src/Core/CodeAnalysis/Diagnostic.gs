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
        properties ImmutableDictionary[string, string?]
    ) {
        Descriptor = descriptor
        Location = location
        Id = descriptor.Id
        Severity = severity
        Message = message
        AdditionalLocations = additionalLocations
        Properties = properties
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
        return if Descriptor is {} descriptor {
            Diagnostic(descriptor, Location, severity, Message, AdditionalLocations, Properties)
        } else {
            Diagnostic(Location, Id, severity, Message)
        }
    }

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
                properties ?? ImmutableDictionary[string, string?].Empty
            )
        }
    }
}
