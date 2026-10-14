// <copyright file="Constants.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

/// Constants used in GSharp LanguageServer.
shared class Constants {
    /// Gets GSharp language identifier.
    private let _languageIdentifier string = "G#"

    prop LanguageIdentifier string {
        get {
            return _languageIdentifier
        }
    }

    /// Gets the GSharp language id advertised by the vscode client (used for document filters).
    private let _languageId string = "gsharp"

    prop LanguageId string {
        get {
            return _languageId
        }
    }
}
