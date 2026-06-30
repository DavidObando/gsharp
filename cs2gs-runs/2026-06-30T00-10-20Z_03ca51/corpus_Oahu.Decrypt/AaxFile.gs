package Oahu.Decrypt

import System
import System.Collections.Generic
import System.IO
import System.Linq
import Oahu.Decrypt.FrameFilters
import Oahu.Decrypt.FrameFilters.Audio
import Oahu.Decrypt.Mpeg4.Boxes
import Oahu.Decrypt.Mpeg4.Util

class AaxFile : Mp4File {
    init(file Stream, fileSize int64, additionalFixups bool = true) : base(file, fileSize) {
        if FileType != FileType.Aax && FileType != FileType.Aaxc {
            throw ArgumentException("This instance of ${nameof(Mp4File)} is not an Aax or Aaxc file.")
        }
        let esds EsdsBox? = AudioSampleEntry.Esds as EsdsBox
        if esds != nil {
            esds.ES_Descriptor.DecoderConfig.AudioSpecificConfig.DependsOnCoreCoder = false
        }
        AudioSampleEntry.Header.ChangeAtomName("mp4a")
        if additionalFixups {
            let children = AudioSampleEntry.Children
            for var i = children.Count - 1; i >= 0; i-- {
                if children[i] is FreeBox {
                    children.RemoveAt(i)
                }
            }
            Ftyp = FtypBox.Create("isom", 0x200)
            Ftyp.CompatibleBrands.Add("iso2")
            Ftyp.CompatibleBrands.Add("mp41")
            Ftyp.CompatibleBrands.Add("M4A ")
            Ftyp.CompatibleBrands.Add("M4B ")
        }
    }

    convenience init(file Stream) {
        init(file, file.Length)
    }

    convenience init(fileName string, access FileAccess = 1, share FileShare = 1) {
        init(File.Open(fileName, FileMode.Open, access, share))
    }

    prop Key []?uint8
    prop IV []?uint8

    override func GetAudioFrameFilter() FrameTransformBase[FrameEntry, FrameEntry] {
        return if Key != nil && IV != nil { AavdFilter(Key!!, IV!!) } else { throw InvalidOperationException("This instance of ${nameof(AaxFile)} does not have a decryption key set.")
            default(AavdFilter) }
    }

    func SetDecryptionKey(activationBytes string) {
        if String.IsNullOrWhiteSpace(activationBytes) || activationBytes.Length != 8 {
            throw ArgumentException("${nameof(activationBytes)} must be 4 bytes long.")
        }
        let actBytes = ByteUtil.BytesFromHexString(activationBytes)
        SetDecryptionKey(actBytes)
    }

    func SetDecryptionKey(activationBytes []?uint8) {
        if activationBytes == nil || activationBytes!!.Length != 4 {
            throw ArgumentException("${nameof(activationBytes)} must be 4 bytes long.")
        }
        if FileType != FileType.Aax {
            throw ArgumentException("This instance of ${nameof(AaxFile)} is not an ${FileType.Aax} file.")
        }
        let adrm = AudioSampleEntry.GetChild[AdrmBox]() ?? throw InvalidOperationException("This instance of ${nameof(AaxFile)} does not contain an adrm box.")
        let intermediate_key = Crypto.Sha1((AaxFile.AudibleFixedKey, 0, AaxFile.AudibleFixedKey.Length), (activationBytes!!, 0, activationBytes!!.Length))
        let intermediate_iv = Crypto.Sha1((AaxFile.AudibleFixedKey, 0, AaxFile.AudibleFixedKey.Length), (intermediate_key, 0, intermediate_key.Length), (activationBytes!!, 0, activationBytes!!.Length))
        let calculatedChecksum = Crypto.Sha1((intermediate_key, 0, 16), (intermediate_iv, 0, 16))
        if !ByteUtil.BytesEqual(calculatedChecksum, adrm.Checksum) {
            throw Exception("Calculated checksum doesn't match AAX file checksum.")
        }
        let drmBlob = ByteUtil.CloneBytes(adrm.DrmBlob)
        Crypto.DecryptInPlace(ByteUtil.CloneBytes(intermediate_key, 0, 16), ByteUtil.CloneBytes(intermediate_iv, 0, 16), drmBlob)
        if !ByteUtil.BytesEqual(drmBlob, 0, activationBytes!!, 0, 4, true) {
            throw Exception("Supplied key doesn't match calculated key.")
        }
        let file_key = ByteUtil.CloneBytes(drmBlob, 8, 16)
        let file_iv = Crypto.Sha1((drmBlob, 26, 16), (file_key, 0, 16), (AaxFile.AudibleFixedKey, 0, 16))
        AudioSampleEntry.Children.Remove(adrm)
        let aabd IBox? = AudioSampleEntry.Children.FirstOrDefault((b IBox) -> b.Header.Type == "aabd") as IBox
        if aabd != nil {
            AudioSampleEntry.Children.Remove(aabd)
        }
        SetDecryptionKey(file_key, ByteUtil.CloneBytes(file_iv, 0, 16))
    }

    func SetDecryptionKey(audible_key string, audible_iv string) {
        if String.IsNullOrWhiteSpace(audible_key) || audible_key.Length != 32 {
            throw ArgumentException("${nameof(audible_key)} must be 16 bytes long.")
        }
        if String.IsNullOrWhiteSpace(audible_iv) || audible_iv.Length != 32 {
            throw ArgumentException("${nameof(audible_iv)} must be 16 bytes long.")
        }
        let key = ByteUtil.BytesFromHexString(audible_key)
        let iv = ByteUtil.BytesFromHexString(audible_iv)
        SetDecryptionKey(key, iv)
    }

    func SetDecryptionKey(key []?uint8, iv []?uint8) {
        if key == nil || key!!.Length != 16 {
            throw ArgumentException("${nameof(key)} must be 16 bytes long.")
        }
        if iv == nil || iv!!.Length != 16 {
            throw ArgumentException("${nameof(iv)} must be 16 bytes long.")
        }
        Key = key
        IV = iv
    }

    shared {
        private let AudibleFixedKey []uint8 = []uint8{uint8(0x77), uint8(0x21), uint8(0x4d), uint8(0x4b), uint8(0x19), uint8(0x6a), uint8(0x87), uint8(0xcd), uint8(0x52), uint8(0x00), uint8(0x45), uint8(0xfd), uint8(0x20), uint8(0xa5), uint8(0x1d), uint8(0x67)}
    }
}
