// <copyright file="AssemblyIdentity.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata

/// The identity of an assembly in a (cref:ReferenceImageSet): name, version, culture and public key token.
/// @remarks Two identities are equal when the four parts are equal.
/// The comparison ignores the case of the name and the culture, as the runtime does.
/// ADR-0209 section 6, row "Assembly identity".
internal class AssemblyIdentity : IEquatable[AssemblyIdentity] {
    internal init(name string, version Version, cultureName string, publicKeyToken ImmutableArray[uint8]) {
        Name = name
        Version = version
        CultureName = cultureName
        PublicKeyToken = if publicKeyToken.IsDefault {
            ImmutableArray[uint8].Empty
        } else {
            publicKeyToken
        }
    }

    /// Gets the simple name.
    internal prop Name string

    /// Gets the version.
    internal prop Version Version

    /// Gets the culture name. The neutral culture is the empty string.
    internal prop CultureName string

    /// Gets the public key token. It is empty when the assembly has no strong name.
    internal prop PublicKeyToken ImmutableArray[uint8]

    func Equals(other AssemblyIdentity?) bool {
        if other == nil {
            return false
        }
        return string.Equals(Name, other.Name, StringComparison.OrdinalIgnoreCase) &&
            Version == other.Version &&
            string.Equals(CultureName, other.CultureName, StringComparison.OrdinalIgnoreCase) && PublicKeyToken.AsSpan()
            .SequenceEqual(other.PublicKeyToken.AsSpan())
    }

    override func Equals(obj object?) bool -> obj is AssemblyIdentity other && Equals(other)

    override func GetHashCode() int32 -> HashCode.Combine(StringComparer.OrdinalIgnoreCase.GetHashCode(Name), Version)

    /// Spells the identity as an assembly display name.
    override func ToString() string {
        let culture = if CultureName.Length == 0 {
            "neutral"
        } else {
            CultureName
        }
        let token = if PublicKeyToken.IsEmpty {
            "null"
        } else {
            Convert.ToHexString(PublicKeyToken.AsSpan()).ToLowerInvariant()
        }
        return "${Name}, Version=${Version}, Culture=${culture}, PublicKeyToken=${token}"
    }

    shared {
        /// Reads the identity from the assembly definition row of a reader.
        /// @exception InvalidOperationException The metadata has no assembly definition.
        internal func FromDefinition(reader MetadataReader) AssemblyIdentity -> FromName(
            reader.GetAssemblyDefinition().GetAssemblyName()
        )

        /// Reads the identity from an assembly reference row.
        internal func FromReference(reference AssemblyReference) AssemblyIdentity -> FromName(
            reference.GetAssemblyName()
        )

        private func FromName(name AssemblyName) AssemblyIdentity {
            let token = name.GetPublicKeyToken()
            return AssemblyIdentity(
                name.Name ?? string.Empty,
                name.Version ?? Version(0, 0, 0, 0),
                name.CultureName ?? string.Empty,
                if token == nil {
                    ImmutableArray[uint8].Empty
                } else {
                    ImmutableArray.Create(token)
                }
            )
        }
    }
}
