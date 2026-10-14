// <copyright file="ResxEntry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Resx

/// One `<data>` resource entry parsed from a `.resx` file
/// (ADR-0142). Mirrors the subset of the resx schema the strongly-typed
/// designer generator cares about: the resource's (cref:Name), its
/// literal or base64-encoded (cref:Value), the optional developer
/// (cref:Comment) (used to seed the generated property's doc comment),
/// and — for a non-string resource — the assembly-qualified (cref:TypeName)
/// and/or (cref:MimeType) that select how the property reads the value
/// back out of the `ResourceManager`.
class ResxEntry {
    /// Initializes a new instance of the (cref:ResxEntry) class.
    /// @param name The resource's `name` attribute.
    /// @param value The resource's `<value>` text.
    /// @param comment The resource's optional `<comment>` text.
    /// @param typeName The resource's optional `type` attribute (assembly-qualified CLR type name).
    /// @param mimeType The resource's optional `mimetype` attribute (marks a base64-encoded binary
    /// payload).
    init(name string, value string, comment string, typeName string, mimeType string) {
        this.Name = name
        this.Value = value
        this.Comment = comment
        this.TypeName = typeName
        this.MimeType = mimeType
    }

    /// Gets the resource's `name` attribute — the resx key.
    prop Name string {
        get;
    }

    /// Gets the resource's raw `<value>` text.
    prop Value string {
        get;
    }

    /// Gets the resource's optional `<comment>` text, or an empty string.
    prop Comment string {
        get;
    }

    /// Gets the resource's optional `type` attribute — an assembly-qualified
    /// CLR type name (e.g. `System.Byte[], mscorlib`) present on every
    /// non-string resource. Empty for a plain string resource.
    prop TypeName string {
        get;
    }

    /// Gets the resource's optional `mimetype` attribute, present when
    /// (cref:Value) is a base64-encoded binary payload. Empty for a
    /// plain string resource.
    prop MimeType string {
        get;
    }

    /// Gets a value indicating whether this resource is a plain string —
    /// the dominant case, and the only one that reads back through
    /// `ResourceManager.GetString` rather than `GetObject`.
    prop IsString bool -> string.IsNullOrEmpty(this.TypeName) && string.IsNullOrEmpty(this.MimeType)
}
