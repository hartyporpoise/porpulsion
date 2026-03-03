{{/* Define some common names */}}
{{- define "porpulsion.fullname" -}}
{{- printf "%s" .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
