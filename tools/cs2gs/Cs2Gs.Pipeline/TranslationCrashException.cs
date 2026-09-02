// <copyright file="TranslationCrashException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #3804: names the C# file the translator was working on when it threw.
/// <para>
/// A crash artifact used to carry no location at all — "translate stage crashed
/// (IndexOutOfRangeException)", no file, no line, no construct — which made it
/// nearly unactionable: the reader's first job was re-running the whole
/// migration with a debugger attached just to learn WHICH of an app's several
/// hundred sources was involved. The translate stage now re-throws inside this
/// wrapper, which is deliberately NOT a diagnostic: the exception still
/// propagates and still fails the stage as a crash. It only annotates it.
/// </para>
/// <para>
/// The wrapper is transparent to triage: <see cref="TriageBuilder.StageCrash"/>
/// is handed the INNER exception, so the artifact's message, its construct kind
/// and therefore its fingerprint are exactly what they would have been without
/// the wrapper — a crash keeps deduping against its own history across the
/// change.
/// </para>
/// </summary>
public sealed class TranslationCrashException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TranslationCrashException"/> class.
    /// </summary>
    /// <param name="sourceFilePath">The C# file being translated when the crash happened.</param>
    /// <param name="inner">The exception the translator actually threw.</param>
    public TranslationCrashException(string sourceFilePath, Exception inner)
        : base(Describe(sourceFilePath, inner), inner)
    {
        this.SourceFilePath = sourceFilePath;
    }

    /// <summary>
    /// Gets the C# file being translated when the crash happened.
    /// </summary>
    public string SourceFilePath { get; }

    private static string Describe(string sourceFilePath, Exception inner)
    {
        if (inner is null)
        {
            throw new ArgumentNullException(nameof(inner));
        }

        return $"translating {sourceFilePath}: {inner.Message}";
    }
}
