// <copyright file="GeneratorHostDiagnostic.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import GSharp.Core.CodeAnalysis.Text

/// A diagnostic the generator host itself reports (not a generator's), with
/// the user-source location it concerns.
class GeneratorHostDiagnostic {
    /// Initializes a new instance of the (cref:GeneratorHostDiagnostic) class.
    /// @param id The diagnostic id.
    /// @param message The message.
    /// @param location The G# source location.
    init(id string, message string, location TextLocation) {
        Id = id
        Message = message
        Location = location
    }

    /// Gets the diagnostic id.
    prop Id string {
        get;
    }

    /// Gets the message.
    prop Message string {
        get;
    }

    /// Gets the G# source location.
    prop Location TextLocation {
        get;
    }
}
