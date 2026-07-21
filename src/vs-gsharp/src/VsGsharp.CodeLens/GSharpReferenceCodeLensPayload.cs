using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GSharp.VisualStudio;

internal sealed class GSharpReferenceCodeLensPayload
{
    private const string Version = "1";

    private GSharpReferenceCodeLensPayload(IReadOnlyList<GSharpReferenceCodeLensLocation> references)
    {
        References = references;
    }

    internal IReadOnlyList<GSharpReferenceCodeLensLocation> References { get; }

    internal static string Serialize(IEnumerable<GSharpReferenceCodeLensLocation> references)
    {
        var lines = new List<string> { Version };
        lines.AddRange(references.Select(reference => string.Join(
            "|",
            Uri.EscapeDataString(reference.Uri),
            reference.Line.ToString(CultureInfo.InvariantCulture),
            reference.Character.ToString(CultureInfo.InvariantCulture),
            reference.EndCharacter.ToString(CultureInfo.InvariantCulture))));
        return string.Join("\n", lines);
    }

    internal static GSharpReferenceCodeLensPayload Parse(string value)
    {
        string[] lines = value.Split('\n');
        if (lines.Length == 0 || lines[0] != Version)
        {
            throw new FormatException("The G# CodeLens payload version is missing or unsupported.");
        }

        var references = new List<GSharpReferenceCodeLensLocation>(lines.Length - 1);
        for (int i = 1; i < lines.Length; i++)
        {
            string[] fields = lines[i].Split('|');
            if (fields.Length != 4
                || !int.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out int line)
                || !int.TryParse(fields[2], NumberStyles.None, CultureInfo.InvariantCulture, out int character)
                || !int.TryParse(fields[3], NumberStyles.None, CultureInfo.InvariantCulture, out int endCharacter))
            {
                throw new FormatException("The G# CodeLens reference payload is invalid.");
            }

            references.Add(new GSharpReferenceCodeLensLocation(
                Uri.UnescapeDataString(fields[0]),
                line,
                character,
                endCharacter));
        }

        return new GSharpReferenceCodeLensPayload(references);
    }
}

internal sealed class GSharpReferenceCodeLensLocation
{
    internal GSharpReferenceCodeLensLocation(
        string uri,
        int line,
        int character,
        int endCharacter)
    {
        if (string.IsNullOrWhiteSpace(uri)
            || line < 0
            || character < 0
            || endCharacter < character)
        {
            throw new ArgumentException("A CodeLens reference location must contain a valid URI and range.");
        }

        Uri = uri;
        Line = line;
        Character = character;
        EndCharacter = endCharacter;
    }

    internal string Uri { get; }

    internal int Line { get; }

    internal int Character { get; }

    internal int EndCharacter { get; }
}
