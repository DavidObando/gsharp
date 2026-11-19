// <copyright file="TransformationProgram.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.CodeAnalysis.Transformations

import GSharp.Core.CodeAnalysis.CodeFixes
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Where a program came from (ADR-0227 D6).
enum ProgramOrigin {
    /// A person wrote the program.
    HandWritten,

    /// A miner found the program in edit logs.
    Mined,

    /// A synthesizer made the program from repeated edits.
    Synthesized
}

/// The provenance and evidence of a program. The backend records it; a host decides what
/// evidence a program needs (ADR-0227 D6).
class ProgramProvenance {
    init(origin ProgramOrigin, source string?, support int32?) {
        Origin = origin
        Source = source
        Support = support
    }

    /// Gets where the program came from.
    prop Origin ProgramOrigin {
        get;
    }

    /// Gets a free-form description of the source (a log, a commit, a person), or `null`.
    prop Source string? {
        get;
    }

    /// Gets the number of distinct tasks or edits that support the program, or `null`.
    prop Support int32? {
        get;
    }
}

/// When a program runs: the IDs of the diagnostics it fixes, and an optional match on one
/// message argument (ADR-0227 D6).
class ProgramTrigger {
    init(diagnosticIds ImmutableArray[string], argumentIndex int32?, argumentEquals string?) {
        if diagnosticIds.IsDefaultOrEmpty {
            throw FormatException("A trigger needs at least one diagnostic ID.")
        }
        DiagnosticIds = diagnosticIds
        ArgumentIndex = argumentIndex
        ArgumentEquals = argumentEquals
    }

    /// Gets the diagnostic IDs.
    prop DiagnosticIds ImmutableArray[string] {
        get;
    }

    /// Gets the index of the message argument to match, or `null`.
    prop ArgumentIndex int32? {
        get;
    }

    /// Gets the value that the message argument must equal, or `null`.
    prop ArgumentEquals string? {
        get;
    }
}

/// One element of a tree pattern (ADR-0227 D6). The root element is anchored at the token where
/// the diagnostic starts. `Next` and `Previous` move to the neighbouring real token, `Ancestor`
/// moves up to the nearest node of a kind. Every element can name a capture.
class SyntaxPattern {
    init(
        capture string?,
        kind string?,
        text string?,
        sameLine bool,
        next SyntaxPattern?,
        previous SyntaxPattern?,
        ancestor SyntaxPattern?
    ) {
        Capture = capture
        Kind = kind
        Text = text
        SameLine = sameLine
        Next = next
        Previous = previous
        Ancestor = ancestor
    }

    /// Gets the capture name, or `null`.
    prop Capture string? {
        get;
    }

    /// Gets the required `SyntaxKind` name, or `null` for any kind.
    prop Kind string? {
        get;
    }

    /// Gets the required token text, or `null` for any text.
    prop Text string? {
        get;
    }

    /// Gets a value that tells whether this element must be on the line of the element it came from.
    prop SameLine bool {
        get;
    }

    /// Gets the pattern of the next real token, or `null`.
    prop Next SyntaxPattern? {
        get;
    }

    /// Gets the pattern of the previous real token, or `null`.
    prop Previous SyntaxPattern? {
        get;
    }

    /// Gets the pattern of the nearest ancestor of (cref:Kind), or `null`.
    prop Ancestor SyntaxPattern? {
        get;
    }
}

/// A guard predicate over captures (ADR-0227 D6). The set of predicates is closed; a program that
/// names another predicate is invalid when it is loaded.
class GuardPredicate {
    // The predicate names that the interpreter knows.
    shared {
        let KnownPredicates ImmutableHashSet[string] = ImmutableHashSet.Create(
            StringComparer.Ordinal,
            "textEquals",
            "kindIs",
            "sameLine",
            "symbolKind",
            "declaredWith",
            "constructsReferenceType",
            "typeIs",
            "isNullable"
        )
    }

    init(predicate string, capture string, other string?, value string?) {
        if !KnownPredicates.Contains(predicate) {
            throw FormatException("Unknown guard predicate '${predicate}' (ADR-0227 D6).")
        }
        ArgumentException.ThrowIfNullOrEmpty(capture)
        Predicate = predicate
        Capture = capture
        Other = other
        Value = value
    }

    /// Gets the predicate name.
    prop Predicate string {
        get;
    }

    /// Gets the capture that the predicate tests.
    prop Capture string {
        get;
    }

    /// Gets a second capture (for `sameLine`), or `null`.
    prop Other string? {
        get;
    }

    /// Gets the value that the predicate compares with, or `null`.
    prop Value string? {
        get;
    }
}

/// The kind of an (cref:EditOperation).
enum EditOperationKind {
    /// Replace the capture with the template.
    Replace,

    /// Delete the capture (a token also loses the space after it).
    Delete,

    /// Insert the template before the capture.
    InsertBefore,

    /// Insert the template after the capture.
    InsertAfter
}

/// One edit of a program (ADR-0227 D6). A template is text with `${capture}` slots, which take
/// the source text of the capture. A move is a delete and an insert.
class EditOperation {
    init(kind EditOperationKind, capture string, template string?) {
        ArgumentException.ThrowIfNullOrEmpty(capture)
        if kind != EditOperationKind.Delete && template == nil {
            throw FormatException("The edit '${kind}' needs a template.")
        }
        Kind = kind
        Capture = capture
        Template = template
    }

    /// Gets the kind.
    prop Kind EditOperationKind {
        get;
    }

    /// Gets the capture that the edit applies to.
    prop Capture string {
        get;
    }

    /// Gets the template, or `null` for a delete.
    prop Template string? {
        get;
    }
}

/// A data-defined transformation (ADR-0227 D6): a trigger, a pattern with captures, guards and
/// edit operations. (cref:ProgramFixProvider) interprets it. A program is immutable, and its
/// (cref:Version) is the SHA-256 of its canonical JSON form.
class TransformationProgram {
    init(
        id string,
        title string,
        trigger ProgramTrigger,
        pattern SyntaxPattern,
        guards ImmutableArray[GuardPredicate],
        edits ImmutableArray[EditOperation],
        applicability Applicability,
        provenance ProgramProvenance
    ) {
        ArgumentException.ThrowIfNullOrEmpty(id)
        ArgumentException.ThrowIfNullOrEmpty(title)
        ArgumentNullException.ThrowIfNull(trigger)
        ArgumentNullException.ThrowIfNull(pattern)
        ArgumentNullException.ThrowIfNull(provenance)
        if edits.IsDefaultOrEmpty {
            throw FormatException("The program '${id}' has no edit.")
        }
        Id = id
        Title = title
        Trigger = trigger
        Pattern = pattern
        Guards = if guards.IsDefault {
            ImmutableArray[GuardPredicate].Empty
        } else {
            guards
        }
        Edits = edits
        Applicability = applicability
        Provenance = provenance
        let captures = HashSet[string](StringComparer.Ordinal)
        CollectCaptures(pattern, captures)
        for rule in Guards {
            RequireCapture(captures, rule.Capture)
            if rule.Other != nil {
                RequireCapture(captures, rule.Other)
            }
        }
        for edit in Edits {
            RequireCapture(captures, edit.Capture)
        }
        Version = ProgramJson.Hash(this)
    }

    /// Gets the stable ID. It is also the equivalence key of the program's fixes.
    prop Id string {
        get;
    }

    /// Gets the title of the fix.
    prop Title string {
        get;
    }

    /// Gets the trigger.
    prop Trigger ProgramTrigger {
        get;
    }

    /// Gets the pattern.
    prop Pattern SyntaxPattern {
        get;
    }

    /// Gets the guards. All must hold.
    prop Guards ImmutableArray[GuardPredicate] {
        get;
    }

    /// Gets the edits.
    prop Edits ImmutableArray[EditOperation] {
        get;
    }

    /// Gets the highest applicability of the program's fixes. A host can lower it.
    prop Applicability Applicability {
        get;
    }

    /// Gets the provenance.
    prop Provenance ProgramProvenance {
        get;
    }

    /// Gets the SHA-256 of the canonical JSON form, in lowercase hexadecimal.
    prop Version string {
        get;
    }

    /// Returns the canonical JSON form: fixed property order, no insignificant white space.
    /// @returns The JSON text.
    func ToJson() string -> ProgramJson.Write(this)

    shared {
        /// Reads a program from JSON. An unknown property, predicate or operation is an error.
        /// @param json The JSON text of one program.
        /// @returns The program.
        func FromJson(json string) TransformationProgram -> ProgramJson.ReadProgram(json)

        /// Reads an array of programs from JSON.
        /// @param json The JSON text of an array of programs.
        /// @returns The programs, in array order.
        func ListFromJson(json string) ImmutableArray[TransformationProgram] -> ProgramJson.ReadPrograms(json)

        private func CollectCaptures(pattern SyntaxPattern?, captures HashSet[string]) {
            if pattern == nil {
                return
            }
            if pattern.Capture != nil && !captures.Add(pattern.Capture) {
                throw FormatException("The capture '${pattern.Capture}' is named twice.")
            }
            CollectCaptures(pattern.Next, captures)
            CollectCaptures(pattern.Previous, captures)
            CollectCaptures(pattern.Ancestor, captures)
        }

        private func RequireCapture(captures HashSet[string], name string) {
            if !captures.Contains(name) {
                throw FormatException("The capture '${name}' is not in the pattern.")
            }
        }
    }
}
