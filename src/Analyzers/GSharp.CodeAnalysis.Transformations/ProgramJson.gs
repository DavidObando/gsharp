// <copyright file="ProgramJson.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.CodeAnalysis.Transformations

import GSharp.Core.CodeAnalysis.CodeFixes
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Security.Cryptography
import System.Text
import System.Text.Encodings.Web
import System.Text.Json

/// The JSON form of a (cref:TransformationProgram) (ADR-0227 D6). The reader rejects unknown
/// properties, so a program cannot carry data that the interpreter ignores. The writer emits a
/// fixed property order, so equal programs have equal text and an equal hash.
internal shared class ProgramJson {
    func ReadPrograms(json string) ImmutableArray[TransformationProgram] {
        using let document = JsonDocument.Parse(json)
        if document.RootElement.ValueKind != JsonValueKind.Array {
            throw FormatException("Expected a JSON array of programs.")
        }
        let result = ImmutableArray.CreateBuilder[TransformationProgram]()
        for element in document.RootElement.EnumerateArray() {
            result.Add(Program(element))
        }
        return result.ToImmutable()
    }

    func ReadProgram(json string) TransformationProgram {
        using let document = JsonDocument.Parse(json)
        return Program(document.RootElement)
    }

    func Hash(program TransformationProgram) string {
        let bytes = SHA256.HashData(Encoding.UTF8.GetBytes(Write(program)))
        return Convert.ToHexString(bytes).ToLowerInvariant()
    }

    func Write(program TransformationProgram) string {
        let stream = MemoryStream()
        // Relaxed escaping keeps quotes and apostrophes readable in the stored programs.
        using let writer = Utf8JsonWriter(
            stream,
            JsonWriterOptions{Encoder: JavaScriptEncoder.UnsafeRelaxedJsonEscaping}
        )
        writer.WriteStartObject()
        writer.WriteString("id", program.Id)
        writer.WriteString("title", program.Title)
        writer.WritePropertyName("trigger")
        writer.WriteStartObject()
        writer.WritePropertyName("diagnosticIds")
        writer.WriteStartArray()
        for id in program.Trigger.DiagnosticIds {
            writer.WriteStringValue(id)
        }
        writer.WriteEndArray()
        if program.Trigger.ArgumentIndex != nil {
            writer.WriteNumber("argumentIndex", program.Trigger.ArgumentIndex)
        }
        if program.Trigger.ArgumentEquals != nil {
            writer.WriteString("argumentEquals", program.Trigger.ArgumentEquals)
        }
        writer.WriteEndObject()
        writer.WritePropertyName("pattern")
        WritePattern(writer, program.Pattern)
        writer.WritePropertyName("guards")
        writer.WriteStartArray()
        for rule in program.Guards {
            writer.WriteStartObject()
            writer.WriteString("predicate", rule.Predicate)
            writer.WriteString("capture", rule.Capture)
            if rule.Other != nil {
                writer.WriteString("other", rule.Other)
            }
            if rule.Value != nil {
                writer.WriteString("value", rule.Value)
            }
            writer.WriteEndObject()
        }
        writer.WriteEndArray()
        writer.WritePropertyName("edits")
        writer.WriteStartArray()
        for edit in program.Edits {
            writer.WriteStartObject()
            writer.WriteString("op", OperationName(edit.Kind))
            writer.WriteString("capture", edit.Capture)
            if edit.Template != nil {
                writer.WriteString("template", edit.Template)
            }
            writer.WriteEndObject()
        }
        writer.WriteEndArray()
        writer.WriteString("applicability", program.Applicability.ToString())
        writer.WritePropertyName("provenance")
        writer.WriteStartObject()
        writer.WriteString("origin", program.Provenance.Origin.ToString())
        if program.Provenance.Source != nil {
            writer.WriteString("source", program.Provenance.Source)
        }
        if program.Provenance.Support != nil {
            writer.WriteNumber("support", program.Provenance.Support)
        }
        writer.WriteEndObject()
        writer.WriteEndObject()
        writer.Flush()
        return Encoding.UTF8.GetString(stream.ToArray())
    }

    private func WritePattern(writer Utf8JsonWriter, pattern SyntaxPattern) {
        writer.WriteStartObject()
        if pattern.Capture != nil {
            writer.WriteString("capture", pattern.Capture)
        }
        if pattern.Kind != nil {
            writer.WriteString("kind", pattern.Kind)
        }
        if pattern.Text != nil {
            writer.WriteString("text", pattern.Text)
        }
        if pattern.SameLine {
            writer.WriteBoolean("sameLine", true)
        }
        let nextPattern SyntaxPattern? = pattern.Next
        if nextPattern != nil {
            writer.WritePropertyName("next")
            WritePattern(writer, nextPattern)
        }
        let previousPattern SyntaxPattern? = pattern.Previous
        if previousPattern != nil {
            writer.WritePropertyName("previous")
            WritePattern(writer, previousPattern)
        }
        let ancestorPattern SyntaxPattern? = pattern.Ancestor
        if ancestorPattern != nil {
            writer.WritePropertyName("ancestor")
            WritePattern(writer, ancestorPattern)
        }
        writer.WriteEndObject()
    }

    private func Program(element JsonElement) TransformationProgram {
        Require(element, JsonValueKind.Object, "program")
        AllowOnly(
            element,
            "program",
            "id",
            "title",
            "trigger",
            "pattern",
            "guards",
            "edits",
            "applicability",
            "provenance"
        )
        let trigger = Property(element, "trigger")
        AllowOnly(trigger, "trigger", "diagnosticIds", "argumentIndex", "argumentEquals")
        let ids = ImmutableArray.CreateBuilder[string]()
        for id in Property(trigger, "diagnosticIds").EnumerateArray() {
            ids.Add(id.GetString() ?? throw FormatException("A diagnostic ID must be a string."))
        }
        let rules = ImmutableArray.CreateBuilder[GuardPredicate]()
        if element.TryGetProperty("guards", out var guardArray) {
            for rule in guardArray.EnumerateArray() {
                AllowOnly(rule, "guard", "predicate", "capture", "other", "value")
                rules.Add(
                    GuardPredicate(
                        StringProperty(rule, "predicate"),
                        StringProperty(rule, "capture"),
                        OptionalString(rule, "other"),
                        OptionalString(rule, "value")
                    )
                )
            }
        }
        let edits = ImmutableArray.CreateBuilder[EditOperation]()
        for edit in Property(element, "edits").EnumerateArray() {
            AllowOnly(edit, "edit", "op", "capture", "template")
            edits.Add(
                EditOperation(
                    Operation(StringProperty(edit, "op")),
                    StringProperty(edit, "capture"),
                    OptionalString(edit, "template")
                )
            )
        }
        let provenance = if element.TryGetProperty("provenance", out var provenanceElement) {
            AllowOnly(provenanceElement, "provenance", "origin", "source", "support")
            ProgramProvenance(
                Enum.Parse[ProgramOrigin](StringProperty(provenanceElement, "origin")),
                OptionalString(provenanceElement, "source"),
                if provenanceElement.TryGetProperty("support", out var support) {
                    support.GetInt32()
                } else {
                    default(int32?)
                }
            )
        } else {
            ProgramProvenance(ProgramOrigin.HandWritten, nil, nil)
        }
        return TransformationProgram(
            StringProperty(element, "id"),
            StringProperty(element, "title"),
            ProgramTrigger(
                ids.ToImmutable(),
                if trigger.TryGetProperty("argumentIndex", out var index) {
                    index.GetInt32()
                } else {
                    default(int32?)
                },
                OptionalString(trigger, "argumentEquals")
            ),
            Pattern(Property(element, "pattern")),
            rules.ToImmutable(),
            edits.ToImmutable(),
            Enum.Parse[Applicability](StringProperty(element, "applicability")),
            provenance
        )
    }

    private func Pattern(element JsonElement) SyntaxPattern {
        Require(element, JsonValueKind.Object, "pattern")
        AllowOnly(element, "pattern", "capture", "kind", "text", "sameLine", "next", "previous", "ancestor")
        return SyntaxPattern(
            OptionalString(element, "capture"),
            OptionalString(element, "kind"),
            OptionalString(element, "text"),
            element.TryGetProperty("sameLine", out var sameLine) && sameLine.GetBoolean(),
            OptionalPattern(element, "next"),
            OptionalPattern(element, "previous"),
            OptionalPattern(element, "ancestor")
        )
    }

    private func OptionalPattern(element JsonElement, name string) SyntaxPattern? -> if element.TryGetProperty(
        name,
        out var value
    ) {
        Pattern(value)
    } else {
        default(SyntaxPattern?)
    }

    private func Operation(name string) EditOperationKind -> switch name {
        case "replace": EditOperationKind.Replace
        case "delete": EditOperationKind.Delete
        case "insertBefore": EditOperationKind.InsertBefore
        case "insertAfter": EditOperationKind.InsertAfter
        default: throw FormatException("Unknown edit operation '${name}' (ADR-0227 D6).")
    }

    private func OperationName(kind EditOperationKind) string -> switch kind {
        case EditOperationKind.Replace: "replace"
        case EditOperationKind.Delete: "delete"
        case EditOperationKind.InsertBefore: "insertBefore"
        default: "insertAfter"
    }

    private func Require(element JsonElement, kind JsonValueKind, what string) {
        if element.ValueKind != kind {
            throw FormatException("Expected a JSON ${kind} for the ${what}.")
        }
    }

    private func AllowOnly(element JsonElement, what string, names ...string) {
        Require(element, JsonValueKind.Object, what)
        for property in element.EnumerateObject() {
            if Array.IndexOf(names, property.Name) < 0 {
                throw FormatException("Unknown property '${property.Name}' in the ${what} (ADR-0227 D6).")
            }
        }
    }

    private func Property(element JsonElement, name string) JsonElement {
        if !element.TryGetProperty(name, out var value) {
            throw FormatException("Missing property '${name}'.")
        }
        return value
    }

    private func StringProperty(element JsonElement, name string) string -> Property(element, name).GetString() ??
        throw FormatException("The property '${name}' must be a string.")

    private func OptionalString(element JsonElement, name string) string? -> if element.TryGetProperty(
        name,
        out var value
    ) {
        value.GetString()
    } else {
        default(string?)
    }
}
