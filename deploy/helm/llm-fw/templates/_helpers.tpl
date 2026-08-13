{{- define "llm-fw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "llm-fw.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "llm-fw.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "llm-fw.labels" -}}
app.kubernetes.io/name: {{ include "llm-fw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "llm-fw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "llm-fw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The Secret holding the client tokens and any provider keys. */}}
{{- define "llm-fw.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "llm-fw.fullname" . }}
{{- end -}}
{{- end -}}
