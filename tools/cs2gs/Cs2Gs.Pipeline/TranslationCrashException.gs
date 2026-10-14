// <copyright file="TranslationCrashException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System

/// Issue #3804: names the C# file the translator was working on when it threw.
///
/// A crash artifact used to carry no location at all — "translate stage crashed
/// (IndexOutOfRangeException)", no file, no line, no construct — which made it
/// nearly unactionable: the reader's first job was re-running the whole
/// migration with a debugger attached just to learn WHICH of an app's several
/// hundred sources was involved. The translate stage now re-throws inside this
/// wrapper, which is deliberately NOT a diagnostic: the exception still
/// propagates and still fails the stage as a crash. It only annotates it.
///
/// The wrapper is transparent to triage: (cref:TriageBuilder.StageCrash)
/// is handed the INNER exception, so the artifact's message, its construct kind
/// and therefore its fingerprint are exactly what they would have been without
/// the wrapper — a crash keeps deduping against its own history across the
/// change.
class TranslationCrashException : Exception {
    /// Initializes a new instance of the (cref:TranslationCrashException) class.
    /// @param sourceFilePath The C# file being translated when the crash happened.
    /// @param inner The exception the translator actually threw.
    init(sourceFilePath string, inner Exception) : base(Describe(sourceFilePath, inner), inner) {
        this.SourceFilePath = sourceFilePath
    }

    /// Gets the C# file being translated when the crash happened.
    prop SourceFilePath string {
        get;
    }

    shared {
        private func Describe(sourceFilePath string, inner Exception?) string {
            if inner == nil {
                throw ArgumentNullException("inner")
            }
            return "translating $sourceFilePath: ${inner.Message}"
        }
    }
}
